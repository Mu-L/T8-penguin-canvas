const express = require('express');
const config = require('../config');
const { getProjectDatabase } = require('../services/projectDatabase');
const { safeCanvasPatchErrorMessage } = require('../services/canvasPatch');
const { CanvasAgentToolError, executeCanvasAgentTool } = require('../services/canvasAgentTools');

const MAX_AGENT_REQUEST_BYTES = 64 * 1024;

function createCanvasAgentToolsRouter(options = {}) {
  const router = express.Router();
  const database = options.database || getProjectDatabase(config);
  router.post('/tools', (req, res) => {
    try {
      const contentLength = Number(req.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_AGENT_REQUEST_BYTES) {
        return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
      }
      const serialized = JSON.stringify(req.body ?? null);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_REQUEST_BYTES) {
        return res.status(413).json({ success: false, code: 'agent_request_too_large', error: 'Agent 工具请求超过 64 KiB' });
      }
      const data = executeCanvasAgentTool(database, req.body, {
        actorId: 'local-owner',
        role: 'owner',
        sessionId: 'local-canvas-agent',
      });
      return res.json({ success: true, data });
    } catch (error) {
      const status = error instanceof CanvasAgentToolError ? error.status : 400;
      const code = error instanceof CanvasAgentToolError ? error.code : 'agent_tool_failed';
      return res.status(status).json({
        success: false,
        code,
        error: safeCanvasPatchErrorMessage(error?.message, 'Agent 只读工具执行失败'),
      });
    }
  });
  return router;
}

const router = createCanvasAgentToolsRouter();
module.exports = router;
module.exports.createCanvasAgentToolsRouter = createCanvasAgentToolsRouter;
module.exports.MAX_AGENT_REQUEST_BYTES = MAX_AGENT_REQUEST_BYTES;
