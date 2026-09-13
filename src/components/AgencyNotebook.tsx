import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Download, Search } from 'lucide-react'
import { apiJson, type ApiProgress } from '../app/api'
import type { QueryAnswer } from '../agency/types'
import { downloadText } from '../agency/exports'

export type NotebookEntry = { id: number; parentId: number | null; kind: string; title: string; createdAt: string; answer: QueryAnswer; activities: ApiProgress[]; notes: string }
type EntrySummary = Pick<NotebookEntry, 'id' | 'parentId' | 'kind' | 'title' | 'createdAt'> & { notePreview?: string }
function exportEntry(entry: NotebookEntry) {
  const answer = entry.answer
  const report = answer.report
  downloadText(`agency-note-${entry.id}.md`, `# ${entry.title}\n\nSaved ${entry.createdAt}. Evidence as of ${answer.generatedAt}.\n\n${answer.aiGenerated ? `AI synthesis (${answer.model || 'configured provider'}).\n\n` : ''}${answer.answer}\n\n${report ? `${report.method}\n\nInputs: ${JSON.stringify(report.inputs)}\n\n` : ''}## Researcher notes\n\n${entry.notes || 'No notes added.'}\n\n## Sources\n\n${answer.evidenceRefs.map((ref) => `- ${ref}`).join('\n')}\n\n## Limits\n\n${answer.warnings.map((warning) => `- ${warning}`).join('\n')}\n\n## Reproduction\n\n${answer.trace.map((call, i) => `### ${i + 1}. ${call.tool}\n\n\`\`\`json\n${JSON.stringify(call.arguments, null, 2)}\n\`\`\`\n`).join('\n')}`)
}
export function AgencyNotebook({ endpoint, onOpen, onBack }: { endpoint: string; onOpen: (id: number) => void; onBack: () => void }) {
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    void apiJson<{ entries: EntrySummary[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'notebook', query: { search } }), signal: controller.signal }).then(({ entries }) => { setEntries(entries); setMore(entries.length === 30) }).catch((error) => { if (!controller.signal.aborted) setError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [endpoint, search])
  async function older() {
    try { const result = await apiJson<{ entries: EntrySummary[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'notebook', query: { search, before: entries.at(-1)?.id } }) }); setEntries((items) => [...items, ...result.entries]); setMore(result.entries.length === 30) }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not load older notes.') }
  }
  return <section className="agency-notebook"><button className="agency-text-button" onClick={onBack}><ArrowLeft size={14} /> Back to Ask</button><div className="agency-section-heading"><div><h2>City notebook</h2><span>Saved conversations, briefings, and research</span></div></div><label className="agency-notebook-search"><Search size={15} /><input aria-label="Search saved work" placeholder="Search questions and notes" value={search} onChange={(event) => setSearch(event.target.value)} /></label>{error ? <p role="alert" className="agency-error">{error}</p> : null}<div className="agency-notebook-list">{entries.map((entry) => <button key={entry.id} onClick={() => onOpen(entry.id)}><span><small>{entry.kind === 'research' ? 'Research' : entry.kind === 'briefing' ? 'Briefing' : 'Ask'} · {new Date(entry.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small><strong>{entry.title}</strong>{entry.notePreview ? <small>{entry.notePreview}</small> : null}</span><ArrowUpRight size={16} /></button>)}</div>{loading ? <p className="agency-caption" role="status">Loading saved work…</p> : null}{!loading && !entries.length ? <p className="agency-caption">Your questions and completed research will be saved here, with their evidence.</p> : null}{more ? <button className="agency-text-button" onClick={() => void older()}>Load older work</button> : null}</section>
}
export function AgencyNoteEditor({ endpoint, entry, onSave }: { endpoint: string; entry: NotebookEntry; onSave?: (notes: string) => void }) {
  const [notes, setNotes] = useState(entry.notes)
  const [status, setStatus] = useState('')
  async function save() { try { await apiJson(endpoint, { method: 'POST', body: JSON.stringify({ action: 'notebook-note', id: entry.id, notes }) }); setStatus('Saved'); onSave?.(notes) } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not save.') } }
  return <details className="agency-source-details agency-note-editor"><summary>Researcher notes & export</summary><textarea aria-label="Researcher notes" placeholder="Add your interpretation, limitations, or next question…" maxLength={20000} value={notes} onChange={(event) => { setNotes(event.target.value); setStatus('Unsaved changes') }} rows={3} /><div><button className="agency-button" onClick={() => void save()}>Save notes</button><button className="agency-text-button" onClick={() => exportEntry({ ...entry, notes })}><Download size={13} /> Export note</button><span role="status">{status}</span></div></details>
}
