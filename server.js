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
      data: { notes: newNotes }
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
      addLog(`Calendar event ${eventId} not found`, 'warning');
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
      return true;
    }
    addLog(`Failed to delete calendar event ${eventId}: ${error.message}`, 'error');
    throw error;
  }
};

// Compare dates
const isDueDateDifferent = (asanaDueDate, calendarEventDate) => {
  if (!asanaDueDate && !calendarEventDate) return false;
  if (!asanaDueDate || !calendarEventDate) return true;
  
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

// Google Calendar API implementation
const addToGoogleCalendar = async (task) => {
  try {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('Google Calendar credentials not configured');
    }

    if (!config.googleRefreshToken) {
      throw new Error('Google Calendar not authenticated');
    }

    await oauth2Client.getAccessToken();

    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    const event = {
      summary: task.name,
      description: `${task.notes || 'No description available'}\n\nFrom Asana Task: https://app.asana.com/0/0/${task.gid}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'UTC'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'UTC'
      }
    };

    const response = await calendar.events.insert({
      calendarId: config.googleCalendarId,
      resource: event,
    });

    return {
      success: true,
      eventId: response.data.id,
      eventUrl: response.data.htmlLink,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };

  } catch (error) {
    addLog(`Google Calendar error: ${error.message}`, 'error');
    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    return {
      success: true,
      eventId: `mock_event_${task.gid}`,
      eventUrl: null,
      startTime: startDate.toISOString(),
      endTime: new Date(startDate.getTime() + 60 * 60 * 1000).toISOString(),
      note: 'Mock event - Google Calendar failed'
    };
  }
};

// Smart sync function
const processTaskWithSmartSync = async (task) => {
  try {
    const existingEventId = extractCalendarEventId(task.notes);
    
    if (!existingEventId) {
      addLog(`New meeting task found: ${task.name}`, 'info');
      const result = await addToGoogleCalendar(task);
      
      if (result.success && !result.eventId.startsWith('mock_event_')) {
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
        endTime: result.endTime
      };
      
    } else {
      addLog(`Checking existing meeting task: ${task.name}`, 'info');
      
      const existingEvent = await getCalendarEvent(existingEventId);
      
      if (!existingEvent) {
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
          endTime: result.endTime
        };
        
      } else if (isDueDateDifferent(task.due_on, existingEvent.start.dateTime)) {
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
          endTime: result.endTime
        };
        
      } else {
        addLog(`No changes needed for task: ${task.name}`, 'info');
        stats.eventsSkipped++;
        return {
          action: 'skipped',
          taskId: task.gid,
          taskName: task.name,
          eventId: existingEventId,
          eventUrl: existingEvent.htmlLink,
          startTime: existingEvent.start.dateTime,
          endTime: existingEvent.end.dateTime
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
      throw new Error('Missing Asana configuration');
    }

    addLog(`Searching for tasks containing "${config.searchKeyword}"...`, 'info');
    const tasks = await searchAsanaTasks(config.searchKeyword);
    
    if (tasks.length === 0) {
      addLog('No meeting tasks found', 'info');
      stats.totalScans++;
      stats.lastRun = new Date();
      return { success: true, message: 'No tasks found', tasksFound: 0 };
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

// Routes
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
      'POST /api/sync': 'Trigger manual sync',
      'GET /api/logs': 'Get recent logs',
      'GET /api/google-status': 'Check Google Calendar connection',
      'GET /auth/google': 'Authenticate with Google Calendar'
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.1.0',
    environment: process.env.NODE_ENV || 'development',
    port: PORT
  });
});

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

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(-limit).reverse(),
    count: logs.length,
    limit
  });
});

app.post('/api/sync', async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    message: `Automation started - running every ${config.intervalHours} hours`
  });
});

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

app.get('/auth/google', (req, res) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    return res.status(400).send('Google Calendar credentials not configured');
  }

  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
      config.googleRefreshToken = tokens.refresh_token;
      oauth2Client.setCredentials({ refresh_token: tokens.refresh_token });
      
      addLog('Google Calendar authenticated successfully', 'success');
      
      res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>Google Calendar Connected Successfully!</h1>
            <p>Add this to your Railway environment variables:</p>
            <code>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</code>
            <p>Then restart your server.</p>
          </body>
        </html>
      `);
    } else {
      res.status(400).send('No refresh token received');
    }
  } catch (error) {
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

app.get('/api/google-status', async (req, res) => {
  try {
    const isConfigured = !!(config.googleClientId && config.googleClientSecret);
    const isAuthenticated = !!config.googleRefreshToken;
    
    let canCreateEvents = false;
    if (isAuthenticated) {
      try {
        const { token } = await oauth2Client.getAccessToken();
        canCreateEvents = !!token;
      } catch (error) {
        // Token invalid
      }
    }

    res.json({
      configured: isConfigured,
      authenticated: isAuthenticated,
      canCreateEvents,
      authUrl: '/auth/google',
      calendarId: config.googleCalendarId,
      status: canCreateEvents ? 'Ready' : (isConfigured ? 'Needs Authentication' : 'Not Configured')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  addLog(`MPC Server started on port ${PORT}`, 'success');
  
  console.log(`\nMPC Server running with Smart Sync!`);
  console.log(`Port: ${PORT}`);
  console.log(`Asana Token: ${config.asanaToken ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`Google Token: ${config.googleRefreshToken ? 'CONFIGURED' : 'NOT SET'}`);
  
  if (!config.asanaToken) {
    addLog('Warning: ASANA_TOKEN not configured', 'warning');
  }
  if (!config.googleRefreshToken) {
    addLog('Warning: Google Calendar not authenticated', 'warning');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  if (cronJob) cronJob.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (cronJob) cronJob.destroy();
  process.exit(0);
});
