import type { BindingMetadata } from '../../../packages/protocol-runner-core/dist/index.js'

export interface AdapterHealth {
  ok: boolean
  adapter: string
  mode: 'fake' | 'real'
  message?: string
  details?: Record<string, unknown>
}

export interface ThreadSelector {
  thread_id: string
  thread_label?: string
}

export interface SendPromptInput {
  run_instance_id: string
  step_id: string
  prompt: string
  thread_binding: BindingMetadata
}

export interface PromptSendResult {
  send_status: 'sent' | 'not_sent' | 'unknown'
  desktop_result: string
  message?: string
  thread_id?: string | null
  thread_title?: string | null
  turn_id?: string | null
  item_id?: string | null
  selection_confirmed?: boolean | null
  desktop_diagnostics?: Record<string, unknown> | null
}

export interface CodexReadbackResult {
  ok: boolean
  thread_id: string
  text: string
}

export interface DesktopOperatorGateResult {
  ok: boolean
  gate: Record<string, unknown>
}

export interface CodexDesktopAdapter {
  health(): Promise<AdapterHealth>
  getState(): Promise<Record<string, unknown>>
  operatorGateState(): Promise<DesktopOperatorGateResult>
  operatorGateWait(): Promise<DesktopOperatorGateResult>
  operatorGateAllowNow(): Promise<DesktopOperatorGateResult>
  sendPrompt(input: SendPromptInput): Promise<PromptSendResult>
  readback(input: ThreadSelector): Promise<CodexReadbackResult>
}

export interface BindRunInput {
  run_instance_id: string
  binding_kind: BindingMetadata['binding_kind']
  visible_thread_label?: string
  relay_channel_id?: string
  relay_channel_name?: string
  binding_id?: string
}

export interface DiscordRelayAdapter {
  health(): Promise<AdapterHealth>
  ready(): Promise<AdapterHealth>
  getState(): Promise<Record<string, unknown>>
  bindRun(input: BindRunInput): Promise<BindingMetadata>
  publish(input: RelayPublishInput): Promise<RelayPublishResult>
  closeRunBinding(input: CloseRunBindingInput): Promise<RelayCloseResult>
}

export interface SentPromptRecord extends SendPromptInput {
  result: PromptSendResult
}

export interface RelayPublishInput {
  channel_id: string
  binding_id: string
  text: string
  source?: string
  correlation_id?: string
}

export interface RelayPublishResult {
  ok: boolean
  channel_id: string
  message_ids: string[]
  chunk_count: number
  text_sha256?: string
  message?: string
}

export interface CloseRunBindingInput {
  channel_id: string
  force?: boolean
  correlation_id?: string
}

export interface RelayCloseResult {
  ok: boolean
  channel_id: string | null
  cleanup_state: BindingMetadata['cleanup_state']
  message?: string
}

export class FakeCodexDesktopAdapter implements CodexDesktopAdapter {
  readonly sent_prompts: SentPromptRecord[] = []
  private next_result: PromptSendResult | null = null
  private counter = 0

  setNextSendResult(result: PromptSendResult): void {
    this.next_result = result
  }

  async health(): Promise<AdapterHealth> {
    return {
      ok: true,
      adapter: 'codex_desktop',
      mode: 'fake',
      message: 'Fake Codex Desktop adapter is available.',
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    return {
      adapter: 'codex_desktop',
      mode: 'fake',
      sent_prompt_count: this.sent_prompts.length,
      desktopActionQueue: {
        gate_status: 'idle',
        pending_count: 0,
        executing_count: 0,
      },
    }
  }

  async operatorGateState(): Promise<DesktopOperatorGateResult> {
    return {
      ok: true,
      gate: {
        gate_status: 'idle',
        pending_count: 0,
        executing_count: 0,
      },
    }
  }

  async operatorGateWait(): Promise<DesktopOperatorGateResult> {
    return this.operatorGateState()
  }

  async operatorGateAllowNow(): Promise<DesktopOperatorGateResult> {
    return this.operatorGateState()
  }

  async sendPrompt(input: SendPromptInput): Promise<PromptSendResult> {
    this.counter += 1
    const fallback: PromptSendResult = {
      send_status: 'sent',
      desktop_result: 'fake_sent',
      thread_id: null,
      thread_title: input.thread_binding.visible_thread_label ?? null,
      turn_id: `fake_turn_${String(this.counter).padStart(4, '0')}`,
      item_id: `fake_item_${String(this.counter).padStart(4, '0')}`,
      selection_confirmed: true,
    }
    const result = this.next_result ?? fallback
    this.next_result = null
    this.sent_prompts.push({ ...input, result })
    return result
  }

  async readback(input: ThreadSelector): Promise<CodexReadbackResult> {
    return {
      ok: true,
      thread_id: input.thread_id,
      text: '',
    }
  }
}

export class FakeDiscordRelayAdapter implements DiscordRelayAdapter {
  readonly bindings: BindingMetadata[] = []
  readonly closed_bindings: CloseRunBindingInput[] = []

  async health(): Promise<AdapterHealth> {
    return {
      ok: true,
      adapter: 'discord_relay',
      mode: 'fake',
      message: 'Fake Discord Relay adapter is available.',
    }
  }

  async ready(): Promise<AdapterHealth> {
    return {
      ok: true,
      adapter: 'discord_relay_ready',
      mode: 'fake',
      message: 'Fake Discord Relay adapter is ready.',
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    return {
      adapter: 'discord_relay',
      mode: 'fake',
      binding_count: this.bindings.length,
    }
  }

  async bindRun(input: BindRunInput): Promise<BindingMetadata> {
    const binding: BindingMetadata = {
      binding_kind: input.binding_kind,
      visible_thread_label: input.visible_thread_label,
      relay_channel_id: input.relay_channel_id ?? `fake_channel_${input.run_instance_id}`,
      relay_channel_name: input.relay_channel_name ?? `protocol-runner-${input.run_instance_id}`,
      binding_id: input.binding_id ?? `fake_binding_${input.run_instance_id}`,
      cleanup_state: 'active',
    }
    this.bindings.push(binding)
    return binding
  }

  async publish(input: RelayPublishInput): Promise<RelayPublishResult> {
    return {
      ok: true,
      channel_id: input.channel_id,
      message_ids: [`fake_publish_${this.bindings.length + 1}`],
      chunk_count: 1,
      text_sha256: 'fake',
    }
  }

  async closeRunBinding(input: CloseRunBindingInput): Promise<RelayCloseResult> {
    this.closed_bindings.push(input)
    return {
      ok: true,
      channel_id: input.channel_id,
      cleanup_state: 'cleaned_up',
    }
  }
}
