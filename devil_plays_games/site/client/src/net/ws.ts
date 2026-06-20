import type { ServerMsg } from '../state'

const INITIAL_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
const BACKOFF = 2

interface PendingAction {
  data: string
  idem: string
}

export class WS {
  private socket: WebSocket | null = null
  private delay = INITIAL_DELAY_MS
  private pending: PendingAction[] = []
  private closed = false

  constructor(
    private path: string,
    private playerID: string,
    private lastSeq: number,
    private onmessage: (msg: ServerMsg) => void,
  ) {}

  connect() {
    if (this.closed) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}${this.path}?player_id=${encodeURIComponent(this.playerID)}&last_seq=${this.lastSeq}`
    const ws = new WebSocket(url)
    this.socket = ws

    ws.onopen = () => {
      this.delay = INITIAL_DELAY_MS
      this.flush()
    }

    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMsg
        if (msg.type === 'snapshot') this.lastSeq = msg.view.seq
        else if (msg.type === 'event') this.lastSeq = Math.max(this.lastSeq, msg.event.seq)
        this.onmessage(msg)
      } catch { /* ignore malformed messages */ }
    }

    ws.onerror = () => ws.close()

    ws.onclose = () => {
      if (this.closed) return
      const d = this.delay
      this.delay = Math.min(this.delay * BACKOFF, MAX_DELAY_MS)
      setTimeout(() => this.connect(), d)
    }
  }

  // Send a game action. Queued locally if the socket is not open and flushed on reconnect.
  action(type: string, payload: unknown, idem = crypto.randomUUID()) {
    const msg = JSON.stringify({
      type: 'action',
      action: { type, payload, idem, player_id: this.playerID },
    })
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(msg)
    } else {
      this.pending.push({ data: msg, idem })
    }
  }

  close() {
    this.closed = true
    this.socket?.close()
  }

  private flush() {
    const queued = this.pending.splice(0)
    for (const { data } of queued) {
      this.socket?.send(data)
    }
  }
}
