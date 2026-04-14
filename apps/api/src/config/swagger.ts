export const swaggerOption = {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "Convixx API",
      description: "Multi-tenant AI Voice Calling Platform backend. RAG-based question answering with self-hosted LLM and OpenAI fallback.",
      version: "1.0.0",
    },
    servers: [
      { url: "https://convixx.in", description: "Production" },
      { url: "http://localhost:8080", description: "Local development" },
    ],
    tags: [
      { name: "Health", description: "Service health checks" },
      { name: "Customers", description: "Customer and API key management (Admin only)" },
      { name: "Agents", description: "Multi-agent configuration per customer" },
      { name: "Knowledgebase", description: "Q&A knowledge base management" },
      { name: "Ask", description: "RAG-based question answering" },
      { name: "Chat", description: "Chat sessions and messages" },
    ],
    components: {
      securitySchemes: {
        AdminToken: {
          type: "apiKey",
          in: "header",
          name: "x-admin-token",
          description: "Fixed admin token for customer APIs. Set in server .env as ADMIN_TOKEN.",
        },
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Customer API key. Generated via POST /customers/:id/api-key. Scopes KB, agents, ask, chat.",
        },
      },
      schemas: {
        Customer: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            system_prompt: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
        Agent: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            description: { type: "string" },
            system_prompt: { type: "string" },
            is_active: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        KBEntry: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            question: { type: "string" },
            answer: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
        AskResponse: {
          type: "object",
          properties: {
            session_id: { type: "string", format: "uuid" },
            agent_id: { type: "string", format: "uuid", nullable: true },
            agent_name: { type: "string", nullable: true },
            answer: { type: "string" },
            source: { type: "string", enum: ["self-hosted", "openai", "kb-direct", "none"] },
            openai_cost_usd: { type: "number", nullable: true },
            response_time_ms: { type: "number" },
            self_hosted_answer: { type: "string", nullable: true },
            fallback_reason: { type: "string", nullable: true },
          },
        },
      },
    },
  },
};
