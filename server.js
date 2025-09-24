// MPC Server - Express.js API for Claude Connector
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');

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
  lastRun: null
};

let config = {
  asanaToken: process.env.ASANA_TOKEN || '',
  asanaWorkspaceId: process.env.ASANA_WORKSPACE_ID || '',
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  intervalHours: parseInt(process.env.DEFAULT_INTERVAL_HOURS) || 4,
  searchKeyword: process.env.DEFAULT_SEARCH_KEYWORD || 'MEETING'
};

let cronJob = null;

// Utility function to add logs
const addLog = (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message, type, id: Date.now() });
  
  // Keep only last 100 logs
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

    const response = await axios.get('https://app.asana.com/api/1.0/tasks/search', {
      headers: {
        'Authorization': `Bearer ${config.asanaToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        workspace: config.asanaWorkspaceId,
        text: keyword,
        resource_type: 'task',
        'opt_fields': 'gid,name,notes,due_on,assignee.name,projects.name,completed'
      }
    });
    
    // Filter for incomplete tasks containing the keyword
    return response.data.data.filter(task => 
      !task.completed && 
      task.name.toLowerCase().includes(keyword.toLowerCase())
    );
  } catch (error) {
    const errorMsg = error.response?.data?.errors?.[0]?.message || error.message;
    throw new Error(`Asana API error: ${errorMsg}`);
  }
};

// Google Calendar API functions (simplified - you'll need proper OAuth2)
const addToGoogleCalendar = async (task) => {
  try {
    // For now, this is a mock implementation
    // You'll need to implement proper Google Calendar OAuth2 flow
    
    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour duration

    // Mock success - replace with actual Google Calendar API call
    await new Promise(resolve => setTimeout(resolve, 500));
    
    addLog(`📅 Would create calendar event: ${task.name}`, 'info');
    addLog(`   Start: ${startDate.toISOString()}`, 'info');
    addLog(`   End: ${endDate.toISOString()}`, 'info');
    
    return { 
      success: true, 
      eventId: `mock_event_${task.gid}`,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };
    
  } catch (error) {
    throw new Error(`Google Calendar API error: ${error.message}`);
  }
};

// Main sync function
const runSync = async () => {
  addLog('🚀 Starting sync process...', 'info');
  
  try {
    if (!config.asanaToken || !config.asanaWorkspaceId) {
      throw new Error('Missing Asana configuration. Please set ASANA_TOKEN and ASANA_WORKSPACE_ID environment variables.');
    }

    addLog(`🔍 Searching for tasks containing "${config.searchKeyword}"...`, 'info');
    const tasks = await searchAsanaTasks(config.searchKeyword);
    
    if (tasks.length === 0) {
      addLog('📝 No meeting tasks found', 'info');
      stats.totalScans++;
      stats.lastRun = new Date();
      return { success: true, message: 'No tasks found', tasksFound: 0, eventsCreated: 0 };
    }

    addLog(`📋 Found ${tasks.length} meeting task(s)`, 'success');
    stats.tasksFound += tasks.length;

    let eventsCreated = 0;
    const processedTasks = [];
    
    for (const task of tasks) {
      try {
        addLog(`📅 Processing: ${task.name}`, 'info');
        
        const result = await addToGoogleCalendar(task);
        
        if (result.success) {
          addLog(`✅ Added to Google Calendar: ${task.name}`, 'success');
          eventsCreated++;
          processedTasks.push({
            taskId: task.gid,
            taskName: task.name,
            eventId: result.eventId,
            startTime: result.startTime,
            endTime: result.endTime
          });
        } else {
          addLog(`❌ Failed to add to calendar: ${task.name}`, 'error');
        }
        
      } catch (error) {
        addLog(`❌ Error processing task ${task.name}: ${error.message}`, 'error');
      }
    }
    
    stats.totalScans++;
    stats.eventsCreated += eventsCreated;
    stats.lastRun = new Date();
    
    addLog(`✨ Sync completed: ${eventsCreated} events created`, 'success');
    
    return { 
      success: true, 
      message: `Sync completed: ${eventsCreated} events created`,
      tasksFound: tasks.length,
      eventsCreated,
      processedTasks
    };
    
  } catch (error) {
    addLog(`❌ Sync failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
};

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    port: PORT
  });
});

// Root route with API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'MPC Center API',
    version: '1.0.0',
    description: 'Multi-Platform Connection: Asana ↔ Google Calendar',
    status: 'running',
    endpoints: {
      'GET /health': 'Health check',
      'GET /api/status': 'Get current status and stats',
      'GET /api/logs': 'Get recent logs',
      'POST /api/config': 'Update configuration',
      'POST /api/sync': 'Trigger manual sync',
      'POST /api/start': 'Start automation',
      'POST /api/stop': 'Stop automation',
      'DELETE /api/logs': 'Clear logs'
    },
    timestamp: new Date().toISOString()
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
      asanaWorkspaceId: config.asanaWorkspaceId ? '***CONFIGURED***' : 'NOT SET'
    },
    nextRun: cronJob ? 'Scheduled' : 'Not scheduled',
    serverTime: new Date().toISOString()
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(-limit).reverse(), // Most recent first
    count: logs.length,
    limit
  });
});

// Update configuration
app.post('/api/config', (req, res) => {
  const { asanaToken, asanaWorkspaceId, googleCalendarId, intervalHours, searchKeyword } = req.body;
  
  if (asanaToken) config.asanaToken = asanaToken;
  if (asanaWorkspaceId) config.asanaWorkspaceId = asanaWorkspaceId;
  if (googleCalendarId) config.googleCalendarId = googleCalendarId;
  if (intervalHours) config.intervalHours = parseInt(intervalHours);
  if (searchKeyword) config.searchKeyword = searchKeyword;
  
  addLog('⚙️ Configuration updated', 'info');
  
  res.json({ success: true, message: 'Configuration updated', config: {
    ...config,
    asanaToken: config.asanaToken ? '***CONFIGURED***' : 'NOT SET'
  }});
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
  
  // Set up cron job - runs every X hours
  const cronPattern = `0 */${config.intervalHours} * * *`;
  cronJob = cron.schedule(cronPattern, () => {
    addLog('⏰ Scheduled sync triggered', 'info');
    runSync();
  });
  
  addLog(`⚡ Automation started - running every ${config.intervalHours} hours`, 'success');
  
  // Run immediately
  setTimeout(() => runSync(), 1000);
  
  res.json({ 
    success: true, 
    message: `Automation started - running every ${config.intervalHours} hours`,
    nextRun: `In ${config.intervalHours} hours`
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
  
  addLog('⏹️ Automation stopped', 'info');
  res.json({ success: true, message: 'Automation stopped' });
});

// Clear logs
app.delete('/api/logs', (req, res) => {
  const logCount = logs.length;
  logs = [];
  addLog('🧹 Logs cleared', 'info');
  res.json({ success: true, message: `Cleared ${logCount} logs` });
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

// Start server - Railway needs 0.0.0.0 binding
app.listen(PORT, '0.0.0.0', () => {
  addLog(`🚀 MPC Server started on port ${PORT}`, 'success');
  addLog(`Environment: ${process.env.NODE_ENV || 'development'}`, 'info');
  
  console.log(`\n🎉 MPC Server running!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Host: 0.0.0.0`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Asana Token: ${config.asanaToken ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`🏢 Workspace ID: ${config.asanaWorkspaceId ? 'CONFIGURED' : 'NOT SET'}`);
  
  if (!config.asanaToken) {
    addLog('⚠️  Warning: ASANA_TOKEN not configured', 'warning');
  }
  if (!config.asanaWorkspaceId) {
    addLog('⚠️  Warning: ASANA_WORKSPACE_ID not configured', 'warning');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  addLog('📴 Server shutting down gracefully...', 'info');
  if (cronJob) {
    cronJob.destroy();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  addLog('📴 Server shutting down gracefully...', 'info');
  if (cronJob) {
    cronJob.destroy();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  addLog(`Uncaught Exception: ${error.message}`, 'error');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  addLog(`Unhandled Rejection: ${reason}`, 'error');
});
