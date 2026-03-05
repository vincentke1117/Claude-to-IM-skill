import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

describe('CodexProvider', () => {
  it('emits error when SDK is not installed', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.ok(
      errorEvent!.data.includes('@openai/codex-sdk'),
      'Error should mention the SDK package name',
    );
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps fileChange item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'fileChange',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcpToolCall item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { output: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });
});
