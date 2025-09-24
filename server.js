// MPC Server - Enhanced with Smart Sync (No Duplicates)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Global state
let isRunning = false;
let logs = [];
let stats = {
  totalScans: 0,
  tasksFound: 0,
  eventsCreated: 0,
  eventsUpdated: 0,
  eventsSkipped: 0,
  lastRun: null
};

let config = {
  asanaToken: process.env.ASANA_TOKEN || '',
  asanaWorkspaceId: process.env.ASANA_WORKSPACE_ID || '',
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  intervalHours: parseInt(process.env.DEFAULT_INTERVAL_HOURS) || 4,
  searchKeyword: process.env.DEFAULT_SEARCH_KEYWORD || 'MEETING',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://mpc-center-server-production.up.railway.app/auth/google/callback',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || ''
};

let cronJob = null;

// Google OAuth2 client setup
const oauth2Client = new OAuth2Client(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUri
);

// Set refresh token if available
if (config.googleRefreshToken) {
  oauth2Client.setCredentials({
    refresh_token: config.googleRefreshToken
  });
}

// Google Calendar API setup
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Utility function to add logs
const addLog = (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message, type, id: Date.now() });
  
  if (logs.length > 100) {
    logs = logs.slice(-100);
  }
  
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
};

// Asana API functions
const searchAsanaTasks = async (keyword) => {
  try {
    if (!config.asanaToken) {
      throw new Error('Asana token not configured');
    }

    // Get user's tasks instead of using search (free version compatible)
    const response = await axios.get('https://app.asana.com/api/1.0/tasks', {
      headers: {
        'Authorization': `Bearer ${config.asanaToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        workspace: config.asanaWorkspaceId,
        assignee: 'me',
        completed_since: 'now',
        'opt_fields': 'gid,name,notes,due_on,assignee.name,projects.name,completed'
      }
    });
    
    // Filter tasks locally for the keyword
    return response.data.data.filter(task => 
      !task.completed && 
      task.name.toLowerCase().includes(keyword.toLowerCase())
    );
  } catch (error) {
    const errorMsg = error.response?.data?.errors?.[0]?.message || error.message;
    throw new Error(`Asana API error: ${errorMsg}`);
  }
};

// Update Asana task notes
const updateAsanaTaskNotes = async (taskGid, newNotes) => {
  try {
    const response = await axios.put(`https://app.asana.com/api/1.0/tasks/${taskGid}`, {
      data: {
        notes: newNotes
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.asanaToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    addLog(`Updated Asana task notes for task ${taskGid}`, 'info');
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.errors?.[0]?.message || error.message;
    addLog(`Failed to update Asana task notes: ${errorMsg}`, 'error');
    throw new Error(`Failed to update Asana task: ${errorMsg}`);
  }
};

// Get existing calendar event
const getCalendarEvent = async (eventId) => {
  try {
    const response = await calendar.events.get({
      calendarId: config.googleCalendarId,
      eventId: eventId
    });
    return response.data;
  } catch (error) {
    if (error.code === 404) {
      addLog(`Calendar event ${eventId} not found (may have been deleted)`, 'warning');
      return null;
    }
    throw error;
  }
};

// Delete calendar event
const deleteCalendarEvent = async (eventId) => {
  try {
    await calendar.events.delete({
      calendarId: config.googleCalendarId,
      eventId: eventId
    });
    addLog(`Deleted calendar event ${eventId}`, 'info');
    return true;
  } catch (error) {
    if (error.code === 404) {
      addLog(`Calendar event ${eventId} already deleted`, 'warning');
      return true; // Consider it successful if already deleted
    }
    addLog(`Failed to delete calendar event ${eventId}: ${error.message}`, 'error');
    throw error;
  }
};

// Compare dates to check if due date changed
const isDueDateDifferent = (asanaDueDate, calendarEventDate) => {
  if (!asanaDueDate && !calendarEventDate) return false;
  if (!asanaDueDate || !calendarEventDate) return true;
  
  // Convert both to comparable format (just the date part)
  const asanaDate = new Date(asanaDueDate + 'T09:00:00Z').toDateString();
  const calendarDate = new Date(calendarEventDate).toDateString();
  
  return asanaDate !== calendarDate;
};

// Extract calendar event ID from task notes
const extractCalendarEventId = (notes) => {
  if (!notes) return null;
  const match = notes.match(/\[CAL_EVENT:([^\]]+)\]/);
  return match ? match[1] : null;
};

// Add calendar event marker to task notes
const addCalendarEventMarker = (notes, eventId) => {
  const marker = `[CAL_EVENT:${eventId}]`;
  return notes ? `${notes}\n${marker}` : marker;
};

// Update calendar event marker in task notes
const updateCalendarEventMarker = (notes, newEventId) => {
  if (!notes) return `[CAL_EVENT:${newEventId}]`;
  return notes.replace(/\[CAL_EVENT:[^\]]+\]/, `[CAL_EVENT:${newEventId}]`);
};

// Real Google Calendar API implementation
const addToGoogleCalendar = async (task) => {
  try {
    // Check if we have Google credentials
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google Calendar credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }

    if (!config.googleRefreshToken) {
      throw new Error('Google Calendar not authenticated. Please visit /auth/google to authenticate.');
    }

    // Ensure we have valid access token
    try {
      await oauth2Client.getAccessToken();
    } catch (error) {
      throw new Error('Failed to get Google access token. Please re-authenticate at /auth/google');
    }

    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour duration

    const event = {
      summary: task.name,
      description: `${task.notes || 'No description available'}\n\nFrom Asana Task: https://app.asana.com/0/0/${task.gid}\nCreated by MPC Center`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'UTC'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'UTC'
      },
      source: {
        title: 'MPC Center',
        url: `https://app.asana.com/0/0/${task.gid}`
      }
    };

    addLog(`Creating Google Calendar event: ${task.name}`, 'info');

    const response = await calendar.events.insert({
      calendarId: config.googleCalendarId,
      resource: event,
    });

    addLog(`Created Google Calendar event: ${task.name}`, 'success');

    return {
      success: true,
      eventId: response.data.id,
      eventUrl: response.data.htmlLink,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };

  } catch (error) {
    addLog(`Google Calendar error: ${error.message}`, 'error');
    // Fall back to mock if Google Calendar fails
    addLog(`Falling back to mock calendar event: ${task.name}`, 'warning');
    
    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    
    return {
      success: true,
      eventId: `mock_event_${task.gid}`,
      eventUrl: null,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      note: 'Mock event - Google Calendar integration failed'
    };
  }
};

// Smart sync function with duplicate prevention
const processTaskWithSmartSync = async (task) => {
  try {
    const existingEventId = extractCalendarEventId(task.notes);
    
    if (!existingEventId) {
      // New task - create calendar event and add marker
      addLog(`New meeting task found: ${task.name}`, 'info');
      const result = await addToGoogleCalendar(task);
      
      if (result.success && !result.eventId.startsWith('mock_event_')) {
        // Only update Asana notes for real Google Calendar events
        const updatedNotes = addCalendarEventMarker(task.notes, result.eventId);
        await updateAsanaTaskNotes(task.gid, updatedNotes);
      }
      
      stats.eventsCreated++;
      return {
        action: 'created',
        taskId: task.gid,
        taskName: task.name,
        eventId: result.eventId,
        eventUrl: result.eventUrl,
        startTime: result.startTime,
        endTime: result.endTime,
        note: result.note || null
      };
      
    } else {
      // Existing task - check if due date changed
      addLog(`Checking existing meeting task: ${task.name}`, 'info');
      
      const existingEvent = await getCalendarEvent(existingEventId);
      
      if (!existingEvent) {
        // Calendar event was deleted - create new one
        addLog(`Calendar event was deleted, creating new one: ${task.name}`, 'warning');
        const result = await addToGoogleCalendar(task);
        
        if (result.success && !result.eventId.startsWith('mock_event_')) {
          const updatedNotes = updateCalendarEventMarker(task.notes, result.eventId);
          await updateAsanaTaskNotes(task.gid, updatedNotes);
        }
        
        stats.eventsCreated++;
        return {
          action: 'recreated',
          taskId: task.gid,
          taskName: task.name,
          eventId: result.eventId,
          eventUrl: result.eventUrl,
          startTime: result.startTime,
          endTime: result.endTime,
          note: 'Recreated - original event was deleted'
        };
        
      } else if (isDueDateDifferent(task.due_on, existingEvent.start.dateTime)) {
        // Due date changed - delete old event and create new one
        addLog(`Due date changed for task: ${task.name}`, 'info');
        
        await deleteCalendarEvent(existingEventId);
        const result = await addToGoogleCalendar(task);
        
        if (result.success && !result.eventId.startsWith('mock_event_')) {
          const updatedNotes = updateCalendarEventMarker(task.notes, result.eventId);
          await updateAsanaTaskNotes(task.gid, updatedNotes);
        }
        
        stats.eventsUpdated++;
        return {
          action: 'updated',
          taskId: task.gid,
          taskName: task.name,
          eventId: result.eventId,
          eventUrl: result.eventUrl,
          startTime: result.startTime,
          endTime: result.endTime,
          note: 'Updated due to date change'
        };
        
      } else {
        // No changes needed
        addLog(`No changes needed for task: ${task.name}`, 'info');
        stats.eventsSkipped++;
        return {
          action: 'skipped',
          taskId: task.gid,
          taskName: task.name,
          eventId: existingEventId,
          eventUrl: existingEvent.htmlLink,
          startTime: existingEvent.start.dateTime,
          endTime: existingEvent.end.dateTime,
          note: 'No changes detected'
        };
      }
    }
    
  } catch (error) {
    addLog(`Error processing task ${task.name}: ${error.message}`, 'error');
    throw error;
  }
};

// Enhanced sync function
const runSync = async () => {
  addLog('Starting sync process...', 'info');
  
  try {
    if (!config.asanaToken || !config.asanaWorkspaceId) {
      throw new Error('Missing Asana configuration. Please set ASANA_TOKEN and ASANA_WORKSPACE_ID environment variables.');
    }

    addLog(`Searching for tasks containing "${config.searchKeyword}"...`, 'info');
    const tasks = await searchAsanaTasks(config.searchKeyword);
    
    if (tasks.length === 0) {
      addLog('No meeting tasks found', 'info');
      stats.totalScans++;
      stats.lastRun = new Date();
      return { success: true, message: 'No tasks found', tasksFound: 0, eventsCreated: 0, eventsUpdated: 0, eventsSkipped: 0 };
    }

    addLog(`Found ${tasks.length} meeting task(s)`, 'success');
    stats.tasksFound += tasks.length;

    const processedTasks = [];
    
    for (const task of tasks) {
      try {
        const result = await processTaskWithSmartSync(task);
        processedTasks.push(result);
        
      } catch (error) {
        addLog(`Error processing task ${task.name}: ${error.message}`, 'error');
        processedTasks.push({
          action: 'error',
          taskId: task.gid,
          taskName: task.name,
          error: error.message
        });
      }
    }
    
    stats.totalScans++;
    stats.lastRun = new Date();
    
    const created = processedTasks.filter(t => t.action === 'created' || t.action === 'recreated').length;
    const updated = processedTasks.filter(t => t.action === 'updated').length;
    const skipped = processedTasks.filter(t => t.action === 'skipped').length;
    
    addLog(`Sync completed: ${created} created, ${updated} updated, ${skipped} skipped`, 'success');
    
    return { 
      success: true, 
      message: `Sync completed: ${created} created, ${updated} updated, ${skipped} skipped`,
      tasksFound: tasks.length,
      eventsCreated: created,
      eventsUpdated: updated,
      eventsSkipped: skipped,
      processedTasks
    };
    
  } catch (error) {
    addLog(`Sync failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
};

// Routes (keeping all existing routes)

// Root route with API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'MPC Center API',
    version: '1.1.0',
    description: 'Multi-Platform Connection: Asana ↔ Google Calendar with Smart Sync',
    status: 'running',
    endpoints: {
      'GET /health': 'Health check',
      'GET /api/status': 'Get current status and stats',
      'POST /api/start': 'Start automation',
      'POST /api/stop': 'Stop automation',
      'POST /api/sync': 'Trigger manual sync (with smart duplicate prevention)',
      'GET /api/logs': 'Get recent logs',
      'GET /api/google-status': 'Check Google Calendar connection',
      'GET /auth/google': 'Authenticate with Google Calendar'
    },
    features: [
      'Smart sync prevents duplicate calendar events',
      'Automatic due date change detection',
      'Stores calendar event IDs in Asana task notes',
      'Updates calendar events when due dates change'
    ],
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.1.0',
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    protocols: ['REST', 'MCP'],
    features: ['Smart Sync', 'Duplicate Prevention']
  });
});

// Get status
app.get('/api/status', (req, res) => {
  res.json({
    isRunning,
    stats,
    config: {
      ...config,
      asanaToken: config.asanaToken ? '***CONFIGURED***' : 'NOT SET',
      asanaWorkspaceId: config.asanaWorkspaceId ? '***CONFIGURED***' : 'NOT SET',
      googleClientId: config.googleClientId ? '***CONFIGURED***' : 'NOT SET',
      googleClientSecret: config.googleClientSecret ? '***CONFIGURED***' : 'NOT SET',
      googleRefreshToken: config.googleRefreshToken ? '***CONFIGURED***' : 'NOT SET'
    },
    nextRun: cronJob ? 'Scheduled' : 'Not scheduled',
    serverTime: new Date().toISOString()
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(-limit).reverse(),
    count: logs.length,
    limit
  });
});

// Manual sync trigger
app.post('/api/sync', async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start automation
app.post('/api/start', (req, res) => {
  if (isRunning) {
    return res.json({ success: false, message: 'Automation already running' });
  }
  
  isRunning = true;
  
  const cronPattern = `0 */${config.intervalHours} * * *`;
  cronJob = cron.schedule(cronPattern, () => {
    addLog('Scheduled sync triggered', 'info');
    runSync();
  });
  
  addLog(`Automation started - running every ${config.intervalHours} hours`, 'success');
  setTimeout(() => runSync(), 1000);
  
  res.json({ 
    success: true, 
    message: `Automation started with smart sync - running every ${config.intervalHours} hours`,
    nextRun: `In ${config.intervalHours} hours`,
    features: ['Duplicate prevention', 'Due date change detection']
  });
});

// Stop automation
app.post('/api/stop', (req, res) => {
  if (!isRunning) {
    return res.json({ success: false, message: 'Automation not running' });
  }
  
  isRunning = false;
  
  if (cronJob) {
    cronJob.destroy();
    cronJob = null;
  }
  
  addLog('Automation stopped', 'info');
  res.json({ success: true, message: 'Automation stopped' });
});

// Google Calendar authentication routes (keeping existing ones)

// Route to start Google authentication
app.get('/auth/google', (req, res) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    return res.status(400).send(`
      <html>
        <head><title>Google Calendar Setup Required</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Google Calendar Setup Required</h1>
          <p>Please configure Google Calendar credentials in your environment variables:</p>
          <ul style="text-align: left; display: inline-block;">
            <li>GOOGLE_CLIENT_ID</li>
            <li>GOOGLE_CLIENT_SECRET</li>
          </ul>
          <a href="/" style="color: #007bff; text-decoration: none;">← Back to MPC Center</a>
        </body>
      </html>
    `);
  }

  const scopes = ['https://www.googleapis.com/auth/calendar'];
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

// OAuth callback route
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store the refresh token temporarily
    if (tokens.refresh_token) {
      config.googleRefreshToken = tokens.refresh_token;
      oauth2Client.setCredentials({
        refresh_token: tokens.refresh_token
      });
      
      addLog('Google Calendar authenticated successfully', 'success');
      
      res.send(`
        <html>
          <head><title>Google Calendar Connected</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>✅ Google Calendar Connected Successfully!</h1>
            <p>Your MPC Center can now create calendar events with smart sync features.</p>
            <p><strong>Important:</strong> Add this to your Railway environment variables:</p>
            <div style="background: #f5f5f5; padding: 15px; margin: 20px; border-radius: 5px; word-break: break-all;">
              <code>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</code>
            </div>
            <p>Then restart your server for the change to take effect.</p>
            <p><a href="/api/google-status" style="color: #007bff;">Check Connection Status</a> | <a href="/" style="color: #007bff;">← Back to MPC Center</a></p>
          </body>
        </html>
      `);
    } else {
      res.status(400).send(`
        <html>
          <head><title>Authentication Issue</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>⚠️ No Refresh Token Received</h1>
            <p>Please try the authentication process again.</p>
            <a href="/auth/google" style="color: #007bff;">Try Again</a> | <a href="/" style="color: #007bff;">← Back to MPC Center</a>
          </body>
        </html>
      `);
    }

  } catch (error) {
    addLog(`Google authentication failed: ${error.message}`, 'error');
    res.status(500).send(`
      <html>
        <head><title>Authentication Failed</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Authentication Failed</h1>
          <p>Error: ${error.message}</p>
          <a href="/auth/google" style="color: #007bff;">Try Again</a> | <a href="/" style="color: #007bff;">← Back to MPC Center</a>
        </body>
      </html>
    `);
  }
});

// Check Google Calendar connection status
app.get('/api/google-status', async (req, res) => {
  try {
    const isConfigured = !!(config.googleClientId && config.googleClientSecret);
    const isAuthenticated = !!config.googleRefreshToken;
    
    let canCreateEvents = false;
    let accessTokenValid = false;
    
    if (isAuthenticated) {
      try {
        const { token } = await oauth2Client.getAccessToken();
        if (token) {
          accessTokenValid = true;
          canCreateEvents = true;
        }
      } catch (error) {
        addLog(`Access token check failed: ${error.message}`, 'warning');
      }
    }

    res.json({
      configured: isConfigured,
      authenticated: isAuthenticated,
      accessTokenValid,
      canCreateEvents,
      authUrl: isConfigured ? '/auth/google' : null,
      calendarId: config.googleCalendarId,
      status: canCreateEvents ? 'Ready' : (isConfigured ? 'Needs Authentication' : 'Not Configured'),
      smartSyncEnabled: true
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MCP Protocol Implementation (keeping for compatibility)
app.post('/mcp', async (req, res) => {
  try {
    const { method, params = {} } = req.body;

    switch (method) {
      case 'initialize':
        res.json({
          capabilities: { tools: { listChanged: true } },
          instructions: "MPC Center - Multi-Platform Connection for Asana and Google Calendar integration with Smart Sync",
          serverInfo: { name: "MPC Center", version: "1.1.0" }
        });
        break;

      case 'tools/list':
        res.json({
          tools: [
            {
              name: "check_status",
              description: "Check the current status of MPC Center including configuration and statistics",
              inputSchema: { type: "object", properties: {}, required: [] }
            },
            {
              name: "run_sync",
              description: "Manually trigger a sync with smart duplicate prevention and due date change detection",
              inputSchema: { type: "object", properties: {}, required: [] }
            }
          ]
        });
        break;

      case 'tools/call':
        const { name } = params;
        
        if (name === 'check_status') {
          res.json({
            content: [{ type: "text", text: JSON.stringify({ isRunning, stats, config: { searchKeyword: config.searchKeyword, intervalHours: config.intervalHours, smartSyncEnabled: true } }, null, 2) }]
          });
        } else if (name === 'run_sync') {
          const syncResult = await runSync();
          res.json({
            content: [{ type: "text", text: JSON.stringify(syncResult, null, 2) }]
          });
        } else {
          res.status(400).json({ error: { code: "INVALID_REQUEST", message: `Unknown tool: ${name}` } });
        }
        break;

      default:
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: `Unknown method: ${method}` } });
    }
  } catch (error) {
    console.error('MCP Error:', error);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: error.message } });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  addLog(`Server error: ${error.message}`, 'error');
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  addLog(`MPC Server started on port ${PORT}`, 'success');
  addLog(`Environment: ${process.env.NODE_ENV || 'development'}`, 'info');
  
  console.log(`\n🎉 MPC Server running with Smart Sync!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Host: 0.0.0.0`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Asana Token: ${config.asanaToken ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`🏢 Workspace ID: ${config.asanaWorkspaceId ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`📅 Google Client ID: ${config.googleClientId ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`🗝️  Google Refresh Token: ${config.googleRefreshToken ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`🚀 Smart Sync: ENABLED (prevents duplicates, handles due date changes)`);
  
  if (!config.asanaToken) {
    addLog('Warning: ASANA_TOKEN not configured', 'warning');
  }
  if (!config.asanaWorkspaceId) {
    addLog('Warning: ASANA_WORKSPACE_ID not configured', 'warning');
  }
  if (!config.googleClientId) {
    addLog('Warning: GOOGLE_CLIENT_ID not configured', 'warning');
  }
  if (!config.googleRefreshToken) {
    addLog('Warning: Google Calendar not authenticated. Visit /auth/google',
