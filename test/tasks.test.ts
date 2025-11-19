import { test } from 'node:test'
import * as assert from 'node:assert'
import Fastify from 'fastify'
import mcpPlugin from '../src/index.ts'
import type { JSONRPCRequest, JSONRPCResponse } from '../src/schema.ts'

test('Tasks Capability', async (t) => {
  await t.test('should create taskService when tasks capability enabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    assert.ok(app.taskService)
    assert.strictEqual(typeof app.taskService.createTask, 'function')
    assert.strictEqual(typeof app.taskService.getTask, 'function')
    assert.strictEqual(typeof app.taskService.listTasks, 'function')
    assert.strictEqual(typeof app.taskService.cancelTask, 'function')

    await app.close()
  })

  await t.test('should not create taskService when tasks capability not enabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      }
    })

    assert.strictEqual(app.taskService, undefined)

    await app.close()
  })

  await t.test('should create task with TTL', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const result = await app.taskService!.createTask(60000)

    assert.ok(result.task)
    assert.ok(result.task.taskId)
    assert.strictEqual(result.task.status, 'working')
    assert.strictEqual(result.task.ttl, 60000)
    assert.ok(result.task.createdAt)
    assert.ok(result.task.pollInterval)

    await app.close()
  })

  await t.test('should get task status', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const createResult = await app.taskService!.createTask(60000)
    const taskId = createResult.task.taskId

    const status = await app.taskService!.getTask(taskId)

    assert.strictEqual(status.taskId, taskId)
    assert.strictEqual(status.status, 'working')
    assert.strictEqual(status.ttl, 60000)

    await app.close()
  })

  await t.test('should list tasks', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    await app.taskService!.createTask(60000)
    await app.taskService!.createTask(60000)

    const tasks = await app.taskService!.listTasks()

    assert.ok(Array.isArray(tasks))
    assert.strictEqual(tasks.length, 2)
    assert.ok(tasks[0].taskId)
    assert.ok(tasks[1].taskId)

    await app.close()
  })

  await t.test('should cancel task', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const createResult = await app.taskService!.createTask(60000)
    const taskId = createResult.task.taskId

    await app.taskService!.cancelTask(taskId)

    const status = await app.taskService!.getTask(taskId)
    assert.strictEqual(status.status, 'cancelled')

    await app.close()
  })

  await t.test('should update task status and result', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const createResult = await app.taskService!.createTask(60000)
    const taskId = createResult.task.taskId

    await app.taskService!.updateTask(taskId, 'completed', { data: 'result' }, 'Task completed successfully')

    const status = await app.taskService!.getTask(taskId)
    assert.strictEqual(status.status, 'completed')
    assert.strictEqual(status.statusMessage, 'Task completed successfully')

    await app.close()
  })

  await t.test('should handle tasks/get request', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const createResult = await app.taskService!.createTask(60000)
    const taskId = createResult.task.taskId

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/get',
      params: {
        taskId
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.strictEqual((result.result as any).taskId, taskId)
    assert.strictEqual((result.result as any).status, 'working')

    await app.close()
  })

  await t.test('should handle tasks/list request', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    await app.taskService!.createTask(60000)
    await app.taskService!.createTask(60000)

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/list',
      params: {}
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)
    assert.ok(Array.isArray((result.result as any).tasks))
    assert.strictEqual((result.result as any).tasks.length, 2)

    await app.close()
  })

  await t.test('should handle tasks/cancel request', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    const createResult = await app.taskService!.createTask(60000)
    const taskId = createResult.task.taskId

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/cancel',
      params: {
        taskId
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok(result.result)

    // Verify task was cancelled
    const status = await app.taskService!.getTask(taskId)
    assert.strictEqual(status.status, 'cancelled')

    await app.close()
  })

  await t.test('should reject tasks/get when capability not enabled', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tools: {}
      }
    })

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/get',
      params: {
        taskId: 'test-task-id'
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: request
    })

    assert.strictEqual(response.statusCode, 200)

    const result = JSON.parse(response.body) as JSONRPCResponse
    assert.ok('error' in result)
    assert.strictEqual((result as any).error.code, -32601) // METHOD_NOT_FOUND

    await app.close()
  })

  await t.test('should clean up expired tasks', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    // Create task with very short TTL (1ms)
    await app.taskService!.createTask(1)

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 10))

    const count = await app.taskService!.cleanup()
    assert.strictEqual(count, 1)

    await app.close()
  })

  await t.test('should filter tasks by authorization context', async (_t) => {
    const app = Fastify()

    await app.register(mcpPlugin, {
      serverInfo: {
        name: 'test-server',
        version: '1.0.0'
      },
      capabilities: {
        tasks: {
          list: {},
          cancel: {}
        }
      }
    })

    // Create tasks with different auth contexts
    await app.taskService!.createTask(60000, { userId: 'user1' })
    await app.taskService!.createTask(60000, { userId: 'user2' })
    await app.taskService!.createTask(60000) // No auth context

    const user1Tasks = await app.taskService!.listTasks({ userId: 'user1' })
    assert.strictEqual(user1Tasks.length, 1)
    assert.ok(user1Tasks[0].taskId)

    const allTasks = await app.taskService!.listTasks()
    assert.strictEqual(allTasks.length, 3)

    await app.close()
  })
})
