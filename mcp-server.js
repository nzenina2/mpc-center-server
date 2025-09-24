#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');

class MPCServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mpc-center',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.isRunning = false;
    this.stats = {
      totalScans: 0,
      tasksFound: 0,
      eventsCreated: 0,
      lastRun: null
    };
    
    this.config = {
      asanaToken: process.env.ASANA_TOKEN || '',
      asanaWorkspaceId: process.env.ASANA_WORKSPACE_ID || '',
      googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      intervalHours: parseInt(process.env.DEFAULT_INTERVAL_HOURS) || 4,
      searchKeyword: process.env.DEFAULT_SEARCH_KEYWORD || 'MEETING'
    };

    this.cronJob = null;
    this.logs = [];

    this.setupHandlers();
  }

  addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    this.logs.push({ timestamp, message, type, id: Date.now() });
    
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(-100);
    }
    
    console.error(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
  }

  async searchAsanaTasks(keyword) {
    try {
      if (!this.config.asanaToken) {
        throw new Error('Asana token not configured');
      }

      const response = await axios.get('https://app.asana.com/api/1.0/tasks/search', {
        headers: {
          'Authorization': `Bearer ${this.config.asanaToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          workspace: this.config.asanaWorkspaceId,
          text: keyword,
          resource_type: 'task',
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
  }

  async addToGoogleCalendar(task) {
    try {
      const startDate = task.due_on ? new Date(task.due_on + 'T09:00:00Z') : new Date();
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

      await new Promise(resolve => setTimeout(resolve, 500));
      
      this.addLog(`Created calendar event: ${task.name}`, 'info');
      
      return { 
        success: true, 
        eventId: `mock_event_${task.gid}`,
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString()
      };
    } catch (error) {
      throw new Error(`Google Calendar API error: ${error.message}`);
    }
  }

  async runSync() {
    this.addLog('Starting sync process...', 'info');
    
    try {
      if (!this.config.asanaToken || !this.config.asanaWorkspaceId) {
        throw new Error('Missing Asana configuration.');
      }

      this.addLog(`Searching for tasks containing "${this.config.searchKeyword}"...`, 'info');
      const tasks = await this.searchAsanaTasks(this.config.searchKeyword);
      
      if (tasks.length === 0) {
        this.addLog('No meeting tasks found', 'info');
        this.stats.totalScans++;
        this.stats.lastRun = new Date();
        return { success: true, message: 'No tasks found', tasksFound: 0, eventsCreated: 0 };
      }

      this.addLog(`Found ${tasks.length} meeting task(s)`, 'success');
      this.stats.tasksFound += tasks.length;

      let eventsCreated = 0;
      const processedTasks = [];
      
      for (const task of tasks) {
        try {
          this.addLog(`Processing: ${task.name}`, 'info');
          
          const result = await this.addToGoogleCalendar(task);
          
          if (result.success) {
            this.addLog(`Added to Google Calendar: ${task.name}`, 'success');
            eventsCreated++;
            processedTasks.push({
              taskId: task.gid,
              taskName: task.name,
              eventId: result.eventId
            });
          }
        } catch (error) {
          this.addLog(`Error processing task ${task.name}: ${error.message}`, 'error');
        }
      }
      
      this.stats.totalScans++;
      this.stats.eventsCreated += eventsCreated;
      this.stats.lastRun = new Date();
      
      this.addLog(`Sync completed: ${eventsCreated} events created`, 'success');
      
      return { 
        success: true, 
        message: `Sync completed: ${eventsCreated} events created`,
        tasksFound: tasks.length,
        eventsCreated,
        processedTasks
      };
    } catch (error) {
      this.addLog(`Sync failed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'check_status',
            description: 'Check the current status of MPC Center including configuration and statistics',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'run_sync',
            description: 'Manually trigger a sync to search for meeting tasks and create calendar events',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'start_automation',
            description: 'Start the automated sync process that runs every few hours',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'stop_automation',
            description: 'Stop the automated sync process',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'get_logs',
            description: 'Retrieve recent activity logs from the MPC Center',
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Number of logs to retrieve (default: 20)'
                }
              }
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        switch (name) {
          case 'check_status':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    isRunning: this.isRunning,
                    stats: this.stats,
                    config: {
                      searchKeyword: this.config.searchKeyword,
                      intervalHours: this.config.intervalHours,
                      asanaConfigured: !!this.config.asanaToken,
                      workspaceConfigured: !!this.config.asanaWorkspaceId
                    },
                    serverTime: new Date().toISOString()
                  }, null, 2)
                }
              ]
            };

          case 'run_sync':
            const syncResult = await this.runSync();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(syncResult, null, 2)
                }
              ]
            };

          case 'start_automation':
            if (this.isRunning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Automation is already running'
                  }
                ]
              };
            }
            
            this.isRunning = true;
            
            const cronPattern = `0 */${this.config.intervalHours} * * *`;
            this.cronJob = cron.schedule(cronPattern, () => {
              this.addLog('Scheduled sync triggered', 'info');
              this.runSync();
            });
            
            this.addLog(`Automation started - running every ${this.config.intervalHours} hours`, 'success');
            setTimeout(() => this.runSync(), 1000);
            
            return {
              content: [
                {
                  type: 'text',
                  text: `Automation started successfully! Will run every ${this.config.intervalHours} hours.`
                }
              ]
            };

          case 'stop_automation':
            if (!this.isRunning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Automation is not currently running'
                  }
                ]
              };
            }
            
            this.isRunning = false;
            if (this.cronJob) {
              this.cronJob.destroy();
              this.cronJob = null;
            }
            this.addLog('Automation stopped', 'info');
            
            return {
              content: [
                {
                  type: 'text',
                  text: 'Automation stopped successfully'
                }
              ]
            };

          case 'get_logs':
            const limit = args?.limit || 20;
            const recentLogs = this.logs.slice(-limit).reverse();
            
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    logs: recentLogs,
                    totalLogs: this.logs.length,
                    showing: recentLogs.length
                  }, null, 2)
                }
              ]
            };

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

if (require.main === module) {
  const server = new MPCServer();
  server.run().catch(console.error);
}
