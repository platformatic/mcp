import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { Type } from '@sinclair/typebox'
import type { ElicitationStore } from '../stores/elicitation-store.ts'

export interface ElicitationRoutesOptions {
  elicitationStore: ElicitationStore
}

// TypeBox schemas for validation
const CompleteParams = Type.Object({
  elicitationId: Type.String()
})

const CompleteBody = Type.Object({
  data: Type.Optional(Type.Any())
})

const SuccessResponse = Type.Object({
  success: Type.Boolean(),
  elicitationId: Type.String()
})

const ErrorResponse = Type.Object({
  error: Type.String(),
  error_description: Type.Optional(Type.String())
})

const elicitationRoutesPlugin: FastifyPluginAsync<ElicitationRoutesOptions> = async (fastify: FastifyInstance, opts) => {
  const { elicitationStore } = opts

  /**
   * Complete an elicitation request.
   *
   * This endpoint is called by the external URL after the user completes
   * the out-of-band data collection flow.
   *
   * POST /elicitation/:elicitationId/complete
   */
  fastify.post('/elicitation/:elicitationId/complete', {
    schema: {
      params: CompleteParams,
      body: CompleteBody,
      response: {
        200: SuccessResponse,
        400: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      const { elicitationId } = request.params as { elicitationId: string }
      const { data } = request.body as { data?: unknown }

      // Retrieve elicitation from store
      const elicitation = await elicitationStore.get(elicitationId)

      if (!elicitation) {
        return reply.status(404).send({
          error: 'not_found',
          error_description: `Elicitation '${elicitationId}' not found`
        })
      }

      // Check if already completed or cancelled
      if (elicitation.status === 'completed') {
        return reply.status(400).send({
          error: 'already_completed',
          error_description: 'Elicitation has already been completed'
        })
      }

      if (elicitation.status === 'cancelled') {
        return reply.status(400).send({
          error: 'cancelled',
          error_description: 'Elicitation has been cancelled'
        })
      }

      // Mark as completed
      await elicitationStore.complete(elicitationId)

      // Send completion notification to the session using decorator
      // The decorator will handle publishing the notification via message broker
      if (fastify.mcpCompleteElicitation) {
        await fastify.mcpCompleteElicitation(elicitationId)
      }

      // Log the completion
      fastify.log.info({ elicitationId, sessionId: elicitation.sessionId, hasData: !!data }, 'Elicitation completed')

      return reply.send({
        success: true,
        elicitationId
      })
    } catch (error) {
      fastify.log.error({ error }, 'Failed to complete elicitation')
      return reply.status(500).send({
        error: 'internal_error',
        error_description: error instanceof Error ? error.message : 'Failed to complete elicitation'
      })
    }
  })

  /**
   * Cancel an elicitation request.
   *
   * This endpoint can be called to cancel a pending elicitation.
   *
   * POST /elicitation/:elicitationId/cancel
   */
  fastify.post('/elicitation/:elicitationId/cancel', {
    schema: {
      params: CompleteParams,
      response: {
        200: SuccessResponse,
        400: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      const { elicitationId } = request.params as { elicitationId: string }

      // Retrieve elicitation from store
      const elicitation = await elicitationStore.get(elicitationId)

      if (!elicitation) {
        return reply.status(404).send({
          error: 'not_found',
          error_description: `Elicitation '${elicitationId}' not found`
        })
      }

      // Check if already completed or cancelled
      if (elicitation.status === 'completed') {
        return reply.status(400).send({
          error: 'already_completed',
          error_description: 'Elicitation has already been completed'
        })
      }

      if (elicitation.status === 'cancelled') {
        return reply.status(400).send({
          error: 'already_cancelled',
          error_description: 'Elicitation has already been cancelled'
        })
      }

      // Mark as cancelled
      await elicitationStore.cancel(elicitationId)

      fastify.log.info({ elicitationId, sessionId: elicitation.sessionId }, 'Elicitation cancelled')

      return reply.send({
        success: true,
        elicitationId
      })
    } catch (error) {
      fastify.log.error({ error }, 'Failed to cancel elicitation')
      return reply.status(500).send({
        error: 'internal_error',
        error_description: error instanceof Error ? error.message : 'Failed to cancel elicitation'
      })
    }
  })

  /**
   * Get elicitation status.
   *
   * This endpoint can be used to check the status of an elicitation.
   *
   * GET /elicitation/:elicitationId/status
   */
  fastify.get('/elicitation/:elicitationId/status', {
    schema: {
      params: CompleteParams,
      response: {
        200: Type.Object({
          elicitationId: Type.String(),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('completed'),
            Type.Literal('cancelled')
          ]),
          message: Type.String(),
          createdAt: Type.String(),
          completedAt: Type.Optional(Type.String())
        }),
        404: ErrorResponse,
        500: ErrorResponse
      }
    }
  }, async (request, reply) => {
    try {
      const { elicitationId } = request.params as { elicitationId: string }

      // Retrieve elicitation from store
      const elicitation = await elicitationStore.get(elicitationId)

      if (!elicitation) {
        return reply.status(404).send({
          error: 'not_found',
          error_description: `Elicitation '${elicitationId}' not found`
        })
      }

      return reply.send({
        elicitationId: elicitation.elicitationId,
        status: elicitation.status,
        message: elicitation.message,
        createdAt: elicitation.createdAt.toISOString(),
        completedAt: elicitation.completedAt?.toISOString()
      })
    } catch (error) {
      fastify.log.error({ error }, 'Failed to get elicitation status')
      return reply.status(500).send({
        error: 'internal_error',
        error_description: error instanceof Error ? error.message : 'Failed to get elicitation status'
      })
    }
  })

  fastify.log.info('Elicitation routes registered')
}

export default fp(elicitationRoutesPlugin, {
  name: 'elicitation-routes'
})
