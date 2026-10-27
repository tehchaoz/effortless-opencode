#!/usr/bin/env node
// A mock OpenAI-compatible server for testing the OpenCode port end to end without a GPU model.
//   - logs every request OpenCode (or the judge) sends to $MOCK_LOG as JSON lines
//   - judge calls (recognised by the judge/handoff system prompts) get a verdict: forwarded to $MOCK_JUDGE_FORWARD
//     (a real OpenAI-compatible base URL) when set, otherwise decided by keyword
//   - main chat calls stream a short reply; if the user text holds <<< ... >>> markers (the /effortless echo), it echoes them
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_PORT || 18099)
const LOG = process.env.MOCK_LOG || '/tmp/mock-llm.jsonl'
const FORWARD = (process.env.MOCK_JUDGE_FORWARD || '').replace(/\/+$/, '')
const FORWARD_MODEL = process.env.MOCK_JUDGE_MODEL || 'qwen3-coder-next'

const lastUser = ms => {
  const u = [...ms].reverse().find(m => m.role === 'user')
  const c = u?.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text ?? '').join('\n') : ''
}
const sysText = ms => ms.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')

http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', d => (raw += d))
    req.on('end', async () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const body = JSON.parse(raw || '{}')
      const sys = sysText(body.messages ?? [])
      const user = lastUser(body.messages ?? [])
      const isJudge = /choose which reasoning effort/.test(sys)
      const isHandoffCheck = /decide whether the person should hand off/.test(sys)
      const kind = isJudge ? 'judge' : isHandoffCheck ? 'handoff-check' : 'chat'
      appendFileSync(LOG, JSON.stringify({ kind, model: body.model, reasoning_effort: body.reasoning_effort ?? null, stream: !!body.stream, tools: (body.tools ?? []).length, sys: sys.slice(0, 60), user: user.slice(-300) }) + '\n')

      if (isJudge || isHandoffCheck) {
        let content
        if (FORWARD) {
          try {
            const r = await fetch(`${FORWARD}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: FORWARD_MODEL, stream: false }) })
            const j = await r.json()
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j))
            return
          } catch (e) {
            content = '{"effort":"medium","why":"forward failed"}'
          }
        } else if (isHandoffCheck) content = /switch topic/i.test(user) ? '{"handoff":"topic changed"}' : '{"handoff":null}'
        else {
          const t = user.toLowerCase()
          const effort = /migrate|entire|whole|refactor|architecture/.test(t) ? 'high' : /what does|rename|typo|thanks/.test(t) ? 'low' : 'medium'
          content = JSON.stringify({ effort, sure: 0.9, why: `mock: ${effort}` })
        }
        const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
        if (body.stream) {
          // The throwaway-session fallback streams: answer as a stream so OpenCode's loop ends.
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const chunk = o => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, ...o })}\n\n`)
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          chunk({ choices: [], usage })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }))
        return
      }

      const echo = user.match(/<<<\n([\s\S]*?)\n>>>/)
      const reply = echo ? echo[1] : 'OK from mock.'
      const usage = { prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020 }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = o => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, ...o })}\n\n`)
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
      chunk({ choices: [{ index: 0, delta: { content: reply } }] })
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      chunk({ choices: [], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock llm on ${PORT}, log ${LOG}${FORWARD ? `, judge forwarded to ${FORWARD}` : ''}`))
