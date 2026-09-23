export type RelayCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'start_new_thread' }
  | { kind: 'show_threads'; group: 'all' | 'pinned' | 'non_pinned' }
  | { kind: 'pickup_thread'; selector: string }
  | { kind: 'check_thread'; selector: string | null }
  | { kind: 'refresh_binding'; selector: string | null }
  | { kind: 'bind_current' }
  | { kind: 'archive_channel' }
  | { kind: 'orchestration_create_run'; title: string }
  | { kind: 'orchestration_show_board' }
  | { kind: 'orchestration_start_worker'; archetype: string; title: string; objective: string }
  | { kind: 'orchestration_refresh_worker_identity'; selector: string }
  | { kind: 'orchestration_show_worker'; selector: string }
  | { kind: 'orchestration_collect_reports' }
  | { kind: 'orchestration_resolve_decision'; decisionId: string; resolution: string }
  | { kind: 'orchestration_close_worker'; selector: string }
  | { kind: 'orchestration_archive_run' }
  | { kind: 'orchestration_cleanup_worker'; selector: string }
  | { kind: 'orchestration_cleanup_run' }
  | { kind: 'orchestration_show_active_run' }
  | { kind: 'orchestration_switch_active_run'; runId: string }
  | { kind: 'orchestration_clear_active_run' }
  | { kind: 'unknown'; reason: string }

function stripCommandPrefix(value: string): string {
  return value
    .replace(/^\s*(?:<@!?\d+>\s*)+/, '')
    .replace(/^\s*(?:@\S+\s*)+/, '')
    .replace(/^\s*(?:!|\/)?\s*/, '')
    .trim()
}

export function parseRelayCommand(rawContent: string): RelayCommand {
  const content = stripCommandPrefix(rawContent).replace(/\s+/g, ' ').trim()
  const lower = content.toLowerCase()

  if (!content) {
    return { kind: 'unknown', reason: 'empty_command' }
  }

  if (lower === 'help') {
    return { kind: 'help' }
  }

  if (lower === 'status') {
    return { kind: 'status' }
  }

  if (lower === 'orchestration help' || lower === 'orchestrate help') {
    return { kind: 'help' }
  }

  if (lower.startsWith('start orchestration run')) {
    const title = content.slice('start orchestration run'.length).trim().replace(/^[:\-\s]+/, '')
    return { kind: 'orchestration_create_run', title: title || 'Orchestration run' }
  }

  if (lower === 'show run board' || lower === 'run board' || lower === 'show board') {
    return { kind: 'orchestration_show_board' }
  }

  if (lower === 'show active run' || lower === 'active run' || lower === 'current run') {
    return { kind: 'orchestration_show_active_run' }
  }

  if (lower === 'clear active run') {
    return { kind: 'orchestration_clear_active_run' }
  }

  const switchActiveRunMatch = content.match(/^(?:switch active run|set active run|use active run)\s+(.+)$/i)
  if (switchActiveRunMatch?.[1]?.trim()) {
    return { kind: 'orchestration_switch_active_run', runId: switchActiveRunMatch[1].trim() }
  }

  if (lower === 'collect reports' || lower === 'collect worker reports') {
    return { kind: 'orchestration_collect_reports' }
  }

  if (lower === 'cleanup run') {
    return { kind: 'orchestration_cleanup_run' }
  }

  if (lower === 'archive run') {
    return { kind: 'orchestration_archive_run' }
  }

  const startWorkerMatch = content.match(/^start worker\s+([^:]+)(?::\s*(.+))?$/i)
  if (startWorkerMatch?.[1]?.trim()) {
    const archetype = startWorkerMatch[1].trim()
    const objective = startWorkerMatch[2]?.trim() || `Run ${archetype}.`
    return {
      kind: 'orchestration_start_worker',
      archetype,
      title: archetype,
      objective,
    }
  }

  const showWorkerMatch = content.match(/^show worker\s+(.+)$/i)
  if (showWorkerMatch?.[1]?.trim()) {
    return { kind: 'orchestration_show_worker', selector: showWorkerMatch[1].trim() }
  }

  const refreshWorkerIdentityMatch = content.match(/^(?:refresh|sync)\s+worker\s+(?:identity|binding)\s+(.+)$/i)
  if (refreshWorkerIdentityMatch?.[1]?.trim()) {
    return {
      kind: 'orchestration_refresh_worker_identity',
      selector: refreshWorkerIdentityMatch[1].trim().replace(/^["']|["']$/g, ''),
    }
  }

  const closeWorkerMatch = content.match(/^close worker\s+(.+)$/i)
  if (closeWorkerMatch?.[1]?.trim()) {
    return { kind: 'orchestration_close_worker', selector: closeWorkerMatch[1].trim() }
  }

  const cleanupWorkerMatch = content.match(/^cleanup worker\s+(.+)$/i)
  if (cleanupWorkerMatch?.[1]?.trim()) {
    return { kind: 'orchestration_cleanup_worker', selector: cleanupWorkerMatch[1].trim() }
  }

  const resolveDecisionMatch = content.match(/^resolve decision\s+([^:]+):\s*(.+)$/i)
  if (resolveDecisionMatch?.[1]?.trim() && resolveDecisionMatch[2]?.trim()) {
    return {
      kind: 'orchestration_resolve_decision',
      decisionId: resolveDecisionMatch[1].trim(),
      resolution: resolveDecisionMatch[2].trim(),
    }
  }

  if (lower === 'start new thread' || lower === 'new thread' || lower === 'start') {
    return { kind: 'start_new_thread' }
  }

  if (lower === 'bind current' || lower === 'bind') {
    return { kind: 'bind_current' }
  }

  if (lower === 'archive' || lower === 'close' || lower === 'cancel') {
    return { kind: 'archive_channel' }
  }

  if (lower === 'check' || lower === 'safe' || lower === 'safe?') {
    return { kind: 'check_thread', selector: null }
  }

  if (lower === 'refresh binding' || lower === 'bind note') {
    return { kind: 'refresh_binding', selector: null }
  }

  if (lower === 'show current threads' || lower === 'show threads' || lower === 'threads') {
    return { kind: 'show_threads', group: 'all' }
  }

  if (lower === 'show current pinned threads' || lower === 'show pinned threads' || lower === 'pinned') {
    return { kind: 'show_threads', group: 'pinned' }
  }

  if (
    lower === 'show current non pinned threads' ||
    lower === 'show current non-pinned threads' ||
    lower === 'show non pinned threads' ||
    lower === 'show non-pinned threads' ||
    lower === 'non pinned' ||
    lower === 'non-pinned'
  ) {
    return { kind: 'show_threads', group: 'non_pinned' }
  }

  const pickupMatch = content.match(/^pickup(?:\s+thread)?\s+(.+)$/i)
  if (pickupMatch?.[1]?.trim()) {
    return { kind: 'pickup_thread', selector: pickupMatch[1].trim().replace(/^["']|["']$/g, '') }
  }

  const checkMatch = content.match(/^check(?:\s+thread)?\s+(.+)$/i)
  if (checkMatch?.[1]?.trim()) {
    return { kind: 'check_thread', selector: checkMatch[1].trim().replace(/^["']|["']$/g, '') }
  }

  const refreshBindingMatch = content.match(/^(?:refresh binding|bind note)(?:\s+(.+))?$/i)
  if (refreshBindingMatch) {
    return {
      kind: 'refresh_binding',
      selector: refreshBindingMatch[1]?.trim().replace(/^["']|["']$/g, '') || null,
    }
  }

  return { kind: 'unknown', reason: 'unrecognized_command' }
}

export function renderHelpText(): string {
  return [
    'Codex Desktop relay commands',
    '',
    'Use these in the command channel unless a line says "inside a companion channel". Mention the bot if Discord hides plain text.',
    '',
    'Thread setup:',
    '- start new thread - Create a new Discord companion channel. Send the first prompt there to create a Codex Desktop thread.',
    '- show current threads - List visible Codex Desktop threads with numbers and safe-to-prompt hints.',
    '- show current pinned threads - List visible pinned desktop threads only.',
    '- show current non pinned threads - List visible non-pinned/project desktop threads only.',
    '- pickup <number-or-title> - Create or reuse a companion channel for an existing desktop thread from the latest list or exact title.',
    '',
    'Safety and binding:',
    '- check <number-or-title> - Check whether a desktop thread looks idle, working, or unknown.',
    '- check - Inside a companion channel, check that channel\'s mapped desktop thread.',
    '- refresh binding <number-or-title> - Inject or retry the Codex self-report binding note for a mapped desktop thread.',
    '- refresh binding - Inside a companion channel, refresh that channel\'s binding note.',
    '- recover publish - Inside a waiting companion channel, ask an idle Codex Desktop thread to publish the missed prior reply.',
    '- bind current - Inside a companion channel, bind it to the currently selected Codex Desktop thread.',
    '',
    'Cleanup and status:',
    '- archive / close / cancel - Inside a companion channel, delete the Discord channel and mapping. Does not archive Codex Desktop.',
    '- status - Show current relay mappings.',
    '- help - Show this command reference.',
    '',
    'Examples:',
    '@YourBot show current threads',
    '@YourBot pickup 9',
    '@YourBot refresh binding',
    '',
    'Orchestration registry (optional external integration, disabled by default):',
    '- start orchestration run <title> - Create and activate a local orchestration run.',
    '- start worker <archetype>: <objective> - Record a registry worker, create a companion channel, and prompt a Codex Desktop worker when the desktop adapter allows it.',
    '- show active run - Show the active run id and current board.',
    '- switch active run <run-id> - Set an existing local orchestration run as active after board validation.',
    '- clear active run - Clear the command-channel active run pointer without archiving anything.',
    '- show run board - Show the active run board.',
    '- collect reports - Collect unread worker reports and open decisions for the active run.',
    '- show worker <number-or-id> - Show one registry worker.',
    '- refresh worker identity <number-or-id> - Repair a worker registry binding from its companion mapping or the currently selected Codex Desktop thread.',
    '- resolve decision <id>: <text> - Resolve an open registry decision.',
    '- close worker <number-or-id> - Archive a registry worker record.',
    '- cleanup worker <number-or-id> - Delete that worker companion Discord channel and archive the worker record. Does not archive Codex Desktop.',
    '- cleanup run - Collect reports, delete worker companion Discord channels, archive/export the active run, and clear it. Does not archive Codex Desktop.',
    '- archive run - Archive/export the active run and clear the command-channel active run.',
    '',
    'Orchestration examples:',
    '@YourBot start orchestration run mobile control build',
    '@YourBot start worker Parallel Build: implement the API slice',
    '@YourBot show run board',
  ].join('\n')
}
