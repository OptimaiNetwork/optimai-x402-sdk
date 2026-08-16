import type { CreateSearchRequest } from "../../dist/index.js";

const agentRequest: CreateSearchRequest = {
  query: "Plan a text-only research task",
  search_mode: "agent",
};

void agentRequest;
