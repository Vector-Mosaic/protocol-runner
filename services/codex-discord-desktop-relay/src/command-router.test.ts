import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRelayCommand, renderHelpText } from './command-router.js'

test('parseRelayCommand recognizes command channel verbs and shorthand forms', () => {
  assert.deepEqual(parseRelayCommand('start new thread'), { kind: 'start_new_thread' })
  assert.deepEqual(parseRelayCommand('<@123456789> start new thread'), { kind: 'start_new_thread' })
  assert.deepEqual(parseRelayCommand('<@!123456789> /show current threads'), { kind: 'show_threads', group: 'all' })
  assert.deepEqual(parseRelayCommand('/show current threads'), { kind: 'show_threads', group: 'all' })
  assert.deepEqual(parseRelayCommand('show current pinned threads'), { kind: 'show_threads', group: 'pinned' })
  assert.deepEqual(parseRelayCommand('show current non-pinned threads'), { kind: 'show_threads', group: 'non_pinned' })
  assert.deepEqual(parseRelayCommand('pickup thread "ATS build plan"'), {
    kind: 'pickup_thread',
    selector: 'ATS build plan',
  })
  assert.deepEqual(parseRelayCommand('pickup 3'), { kind: 'pickup_thread', selector: '3' })
  assert.deepEqual(parseRelayCommand('check 3'), { kind: 'check_thread', selector: '3' })
  assert.deepEqual(parseRelayCommand('check'), { kind: 'check_thread', selector: null })
  assert.deepEqual(parseRelayCommand('refresh binding 3'), { kind: 'refresh_binding', selector: '3' })
  assert.deepEqual(parseRelayCommand('bind note "ATS build plan"'), {
    kind: 'refresh_binding',
    selector: 'ATS build plan',
  })
  assert.deepEqual(parseRelayCommand('refresh binding'), { kind: 'refresh_binding', selector: null })
  assert.deepEqual(parseRelayCommand('bind current'), { kind: 'bind_current' })
  assert.deepEqual(parseRelayCommand('<@123456789> archive'), { kind: 'archive_channel' })
  assert.deepEqual(parseRelayCommand('close'), { kind: 'archive_channel' })
  assert.deepEqual(parseRelayCommand('cancel'), { kind: 'archive_channel' })
  assert.deepEqual(parseRelayCommand('status'), { kind: 'status' })
  assert.deepEqual(parseRelayCommand('help'), { kind: 'help' })
})

test('parseRelayCommand recognizes orchestration registry verbs', () => {
  assert.deepEqual(parseRelayCommand('@YourBot start orchestration run Mobile control build'), {
    kind: 'orchestration_create_run',
    title: 'Mobile control build',
  })
  assert.deepEqual(parseRelayCommand('show run board'), { kind: 'orchestration_show_board' })
  assert.deepEqual(parseRelayCommand('show active run'), { kind: 'orchestration_show_active_run' })
  assert.deepEqual(parseRelayCommand('switch active run run-abc'), {
    kind: 'orchestration_switch_active_run',
    runId: 'run-abc',
  })
  assert.deepEqual(parseRelayCommand('clear active run'), { kind: 'orchestration_clear_active_run' })
  assert.deepEqual(parseRelayCommand('start worker Parallel Build: implement the API slice'), {
    kind: 'orchestration_start_worker',
    archetype: 'Parallel Build',
    title: 'Parallel Build',
    objective: 'implement the API slice',
  })
  assert.deepEqual(parseRelayCommand('show worker 2'), { kind: 'orchestration_show_worker', selector: '2' })
  assert.deepEqual(parseRelayCommand('refresh worker identity 2'), {
    kind: 'orchestration_refresh_worker_identity',
    selector: '2',
  })
  assert.deepEqual(parseRelayCommand('sync worker binding w001'), {
    kind: 'orchestration_refresh_worker_identity',
    selector: 'w001',
  })
  assert.deepEqual(parseRelayCommand('collect reports'), { kind: 'orchestration_collect_reports' })
  assert.deepEqual(parseRelayCommand('resolve decision d-abc: use option A'), {
    kind: 'orchestration_resolve_decision',
    decisionId: 'd-abc',
    resolution: 'use option A',
  })
  assert.deepEqual(parseRelayCommand('close worker w002'), { kind: 'orchestration_close_worker', selector: 'w002' })
  assert.deepEqual(parseRelayCommand('archive run'), { kind: 'orchestration_archive_run' })
  assert.deepEqual(parseRelayCommand('cleanup worker 2'), { kind: 'orchestration_cleanup_worker', selector: '2' })
  assert.deepEqual(parseRelayCommand('cleanup run'), { kind: 'orchestration_cleanup_run' })
})

test('parseRelayCommand returns explicit unknown reasons', () => {
  assert.deepEqual(parseRelayCommand(''), { kind: 'unknown', reason: 'empty_command' })
  assert.deepEqual(parseRelayCommand('please do things'), { kind: 'unknown', reason: 'unrecognized_command' })
})

test('renderHelpText names the supported v1 command surface', () => {
  const help = renderHelpText()
  assert.match(help, /Codex Desktop relay commands/)
  assert.match(help, /Use these in the command channel/)
  assert.match(help, /start new thread/)
  assert.match(help, /Create a new Discord companion channel/)
  assert.match(help, /show current threads/)
  assert.match(help, /pickup <number-or-title>/)
  assert.match(help, /Create or reuse a companion channel/)
  assert.match(help, /check <number-or-title>/)
  assert.match(help, /Inside a companion channel, check/)
  assert.match(help, /refresh binding <number-or-title>/)
  assert.match(help, /Inject or retry the Codex self-report binding note/)
  assert.match(help, /recover publish/)
  assert.match(help, /missed prior reply/)
  assert.match(help, /bind current/)
  assert.match(help, /archive/)
  assert.match(help, /Does not archive Codex Desktop/)
  assert.match(help, /cancel/)
  assert.match(help, /Examples:/)
  assert.match(help, /@YourBot pickup 9/)
  assert.match(help, /Orchestration registry \(optional external integration, disabled by default\):/)
  assert.match(help, /start orchestration run <title>/)
  assert.match(help, /start worker <archetype>: <objective>/)
  assert.match(help, /show active run/)
  assert.match(help, /cleanup run/)
  assert.match(help, /refresh worker identity <number-or-id>/)
  assert.match(help, /show run board/)
})
