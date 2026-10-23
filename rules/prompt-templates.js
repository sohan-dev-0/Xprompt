/**
 * PromptLock — Prompt Templates Preset (Step 4 & Polish)
 *
 * Provides battle-tested architectural templates for common software features.
 * Presets: auth, payment, crud, upload, chat
 */

'use strict';

const TEMPLATES = [
  {
    id: 'auth',
    name: 'Authentication & Session (JWT)',
    description: 'Secure JWT authentication with bcrypt password hashing and token rotation',
    intent: 'Implement JWT user authentication with access/refresh token rotation, bcrypt password hashing, and protected route middleware with Zod schema validation.',
    rules: ['zero-secrets', 'zod-validation', 'sql-guard'],
    recommendedFiles: ['src/auth/auth-controller.js', 'src/auth/jwt-service.js', 'src/middleware/auth-guard.js'],
  },
  {
    id: 'payment',
    name: 'Payment & Checkout (Stripe)',
    description: 'Stripe checkout session creation, webhook verification, and idempotency',
    intent: 'Add Stripe checkout session creation endpoint, secure webhook signature verification, and idempotent transaction recording in database.',
    rules: ['zero-secrets', 'zod-validation', 'sql-guard', 'no-eval'],
    recommendedFiles: ['src/payments/stripe-service.js', 'src/payments/webhook-handler.js', 'src/payments/order-store.js'],
  },
  {
    id: 'crud',
    name: 'RESTful CRUD API with Validation',
    description: 'Full CRUD resource endpoints with Zod payload validation and error masking',
    intent: 'Create RESTful CRUD endpoints for resources with pagination, Zod payload validation, sanitized error responses, and audit logging.',
    rules: ['zod-validation', 'sql-guard', 'no-eval'],
    recommendedFiles: ['src/api/routes.js', 'src/api/controller.js', 'src/api/schema.js'],
  },
  {
    id: 'upload',
    name: 'Secure File Upload & Storage',
    description: 'MIME-type validated file upload handling with disk/S3 storage and size limits',
    intent: 'Implement secure multipart file upload handling with strict MIME-type validation, file size limits, safe filename generation, and cloud/local storage integration.',
    rules: ['zero-secrets', 'zod-validation', 'no-eval'],
    recommendedFiles: ['src/storage/upload-service.js', 'src/middleware/upload-guard.js'],
  },
  {
    id: 'chat',
    name: 'Realtime Chat / WebSockets',
    description: 'WebSocket/Socket.io real-time chat room with connection authentication and message history',
    intent: 'Build a real-time chat system with WebSocket authentication, room-based messaging channels, event rate limiting, and persistent message history.',
    rules: ['zero-secrets', 'zod-validation'],
    recommendedFiles: ['src/chat/socket-gateway.js', 'src/chat/room-manager.js'],
  },
];

function getTemplates() {
  return TEMPLATES;
}

function getTemplateById(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

module.exports = {
  TEMPLATES,
  getTemplates,
  getTemplateById,
};
