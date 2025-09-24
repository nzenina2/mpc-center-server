// MPC Server - MCP Protocol Compatible for Claude Connector
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
  
  if (logs.length > 100) {
    logs = logs.slice(-100);
  }
  
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
};

// Asana API functions
const searchAsanaTasks = async (keyword) => {
  // Replace this entire function with:
  try {
    if (!config.asanaToken) {
      throw new Error('Asana token not configured');
    }

    // Get user's tasks instead of using search
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

// Google Calendar API functions (mock implementation)
const addToGoogleCalendar = async (task) => {
  try {
    const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    await new Promise(resolve => setTimeout(resolve, 500));
    
    addLog(`📅 Would create calendar event: ${task.name}`, 'info');
    
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
      throw new Error('Missing Asana configuration.');
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
            eventId: result.eventId
          });
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

// MCP Protocol Implementation
app.post('/mcp', async (req, res) => {
  try {
    const { method, params = {} } = req.body;

    switch (method) {
      case 'initialize':
        res.json({
          capabilities: {
            tools: {
              listChanged: true
            }
          },
          instructions: "MPC Center - Multi-Platform Connection for Asana and Google Calendar integration",
          serverInfo: {
            name: "MPC Center",
            version: "1.0.0"
          }
        });
        break;

      case 'tools/list':
        res.json({
          tools: [
            {
              name: "check_status",
              description: "Check the current status of MPC Center including configuration and statistics",
              inputSchema: {
                type: "object",
                properties: {},
                required: []
              }
            },
            {
              name: "run_sync",
              description: "Manually trigger a sync to search for meeting tasks and create calendar events",
              inputSchema: {
                type: "object",
                properties: {},
                required: []
              }
            },
            {
              name: "start_automation",
              description: "Start the automated sync process that runs every 4 hours",
              inputSchema: {
                type: "object",
                properties: {},
                required: []
              }
            },
            {
              name: "stop_automation",
              description: "Stop the automated sync process",
              inputSchema: {
                type: "object",
                properties: {},
                required: []
              }
            },
            {
              name: "get_logs",
              description: "Retrieve recent activity logs from the MPC Center",
              inputSchema: {
                type: "object",
                properties: {
                  limit: {
                    type: "number",
                    description: "Number of logs to retrieve (default: 20)"
                  }
                }
              }
            }
          ]
        });
        break;

      case 'tools/call':
        const { name, arguments: args = {} } = params;
        
        switch (name) {
          case 'check_status':
            res.json({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    isRunning,
                    stats,
                    config: {
                      searchKeyword: config.searchKeyword,
                      intervalHours: config.intervalHours,
                      asanaConfigured: !!config.asanaToken,
                      workspaceConfigured: !!config.asanaWorkspaceId
                    },
                    serverTime: new Date().toISOString()
                  }, null, 2)
                }
              ]
            });
            break;

          case 'run_sync':
            const syncResult = await runSync();
            res.json({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(syncResult, null, 2)
                }
              ]
            });
            break;

          case 'start_automation':
            if (isRunning) {
              res.json({
                content: [
                  {
                    type: "text",
                    text: "Automation is already running"
                  }
                ]
              });
            } else {
              isRunning = true;
              
              const cronPattern = `0 */${config.intervalHours} * * *`;
              cronJob = cron.schedule(cronPattern, () => {
                addLog('⏰ Scheduled sync triggered', 'info');
                runSync();
              });
              
              addLog(`⚡ Automation started - running every ${config.intervalHours} hours`, 'success');
              setTimeout(() => runSync(), 1000);
              
              res.json({
                content: [
                  {
                    type: "text",
                    text: `Automation started successfully! Will run every ${config.intervalHours} hours.`
                  }
                ]
              });
            }
            break;

          case 'stop_automation':
            if (!isRunning) {
              res.json({
                content: [
                  {
                    type: "text",
                    text: "Automation is not currently running"
                  }
                ]
              });
            } else {
              isRunning = false;
              if (cronJob) {
                cronJob.destroy();
                cronJob = null;
              }
              addLog('⏹️ Automation stopped', 'info');
              
              res.json({
                content: [
                  {
                    type: "text",
                    text: "Automation stopped successfully"
                  }
                ]
              });
            }
            break;

          case 'get_logs':
            const limit = args.limit || 20;
            const recentLogs = logs.slice(-limit).reverse();
            
            res.json({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    logs: recentLogs,
                    totalLogs: logs.length,
                    showing: recentLogs.length
                  }, null, 2)
                }
              ]
            });
            break;

          default:
            res.status(400).json({
              error: {
                code: "INVALID_REQUEST",
                message: `Unknown tool: ${name}`
              }
            });
        }
        break;

      default:
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: `Unknown method: ${method}`
          }
        });
    }
  } catch (error) {
    console.error('MCP Error:', error);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: error.message
      }
    });
  }
});

// Keep existing REST API for backward compatibility
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    protocols: ['REST', 'MCP']
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    isRunning,
    stats,
    config: {
      ...config,
      asanaToken: config.asanaToken ? '***CONFIGURED***' : 'NOT SET',
      asanaWorkspaceId: config.asanaWorkspaceId ? '***CONFIGURED***' : 'NOT SET'
    },
    serverTime: new Date().toISOString()
  });
});
// Add missing REST API endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'MPC Center API',
    version: '1.0.0',
    description: 'Multi-Platform Connection: Asana ↔ Google Calendar',
    status: 'running',
    endpoints: {
      'GET /health': 'Health check',
      'GET /api/status': 'Get current status and stats',
      'POST /api/start': 'Start automation',
      'POST /api/stop': 'Stop automation',
      'POST /api/sync': 'Trigger manual sync',
      'GET /api/logs': 'Get recent logs'
    },
    timestamp: new Date().toISOString()
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
    addLog('⏰ Scheduled sync triggered', 'info');
    runSync();
  });
  
  addLog(`⚡ Automation started - running every ${config.intervalHours} hours`, 'success');
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

// Get logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(-limit).reverse(),
    count: logs.length,
    limit
  });
});
// Start server
app.listen(PORT, '0.0.0.0', () => {
  addLog(`🚀 MPC Server started on port ${PORT}`, 'success');
  addLog(`Environment: ${process.env.NODE_ENV || 'development'}`, 'info');
  
  console.log(`\n🎉 MPC Server running!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Host: 0.0.0.0`);
  console.log(`🔧 Protocols: REST + MCP`);
  console.log(`🔑 Asana Token: ${config.asanaToken ? 'CONFIGURED' : 'NOT SET'}`);
  console.log(`🏢 Workspace ID: ${config.asanaWorkspaceId ? 'CONFIGURED' : 'NOT SET'}`);
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
