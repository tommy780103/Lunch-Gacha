import { DurableObject } from 'cloudflare:workers';
import { handlePublicRequest, handleQuotaRequest } from './server.mjs';

export class SearchQuota extends DurableObject {
  async fetch(request) {
    return handleQuotaRequest(request, this.env, { storage: this.ctx.storage });
  }
}

export default { fetch: handlePublicRequest };
