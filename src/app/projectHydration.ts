import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { VigoProject } from '../domain'
import { apiJson } from './api'
import { mergeProjectDetail, needsProjectDetail } from './projectState'

type ProjectDetailRequest = {
  controller: AbortController
  promise: Promise<VigoProject | undefined>
}

type ProjectHydrationOptions = {
  projects: VigoProject[]
  selectedProjectId: string
  setProjects: Dispatch<SetStateAction<VigoProject[]>>
  onSelectProject: (projectId: string) => void
  onError: (message: string) => void
}

export function useProjectDetailHydration({
  projects,
  selectedProjectId,
  setProjects,
  onSelectProject,
  onError,
}: ProjectHydrationOptions) {
  const projectDetailRequestsRef = useRef(new Map<string, ProjectDetailRequest>())
  const projectsRef = useRef(projects)
  const selectedProjectIdRef = useRef(selectedProjectId)
  const citySelectionVersionRef = useRef(0)
  const activeCityProjectIdRef = useRef('')
  const callbacksRef = useRef({ onSelectProject, onError })
  const [cityPreviewLoadingProjectId, setCityPreviewLoadingProjectId] = useState('')

  projectsRef.current = projects
  selectedProjectIdRef.current = selectedProjectId
  callbacksRef.current = { onSelectProject, onError }

  function ensureProjectDetail(projectId: string): Promise<VigoProject | undefined> {
    const existing = projectsRef.current.find((project) => project.id === projectId)
    if (!existing || !needsProjectDetail(existing)) return Promise.resolve(existing)

    const pending = projectDetailRequestsRef.current.get(projectId)
    if (pending) return pending.promise

    const controller = new AbortController()
    const promise = apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return undefined
      setProjects((current) => {
        if (controller.signal.aborted) return current
        const next = mergeProjectDetail(current, result.project)
        projectsRef.current = next
        return next
      })
      return result.project
    }).finally(() => {
      const current = projectDetailRequestsRef.current.get(projectId)
      if (current?.controller === controller) projectDetailRequestsRef.current.delete(projectId)
    })

    projectDetailRequestsRef.current.set(projectId, { controller, promise })
    return promise
  }

  function cancelProjectDetail(projectId: string) {
    projectDetailRequestsRef.current.get(projectId)?.controller.abort()
    projectDetailRequestsRef.current.delete(projectId)
    if (activeCityProjectIdRef.current === projectId) {
      citySelectionVersionRef.current += 1
      setCityPreviewLoadingProjectId('')
    }
  }

  function beginCitySelection(projectId: string, projectSnapshot?: VigoProject[]) {
    if (!projectId) return
    if (projectSnapshot) projectsRef.current = projectSnapshot

    const previousProjectId = activeCityProjectIdRef.current
    if (previousProjectId && previousProjectId !== projectId) cancelProjectDetail(previousProjectId)

    const selectionVersion = citySelectionVersionRef.current + 1
    citySelectionVersionRef.current = selectionVersion
    activeCityProjectIdRef.current = projectId
    selectedProjectIdRef.current = projectId
    callbacksRef.current.onSelectProject(projectId)
    setCityPreviewLoadingProjectId(projectId)

    void ensureProjectDetail(projectId).then(() => {
      if (
        citySelectionVersionRef.current !== selectionVersion ||
        activeCityProjectIdRef.current !== projectId ||
        selectedProjectIdRef.current !== projectId
      ) return
      setCityPreviewLoadingProjectId('')
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (
        citySelectionVersionRef.current !== selectionVersion ||
        activeCityProjectIdRef.current !== projectId ||
        selectedProjectIdRef.current !== projectId
      ) return
      setCityPreviewLoadingProjectId('')
      callbacksRef.current.onError(error instanceof Error ? error.message : 'Project detail unavailable')
    })
  }

  useEffect(() => () => {
    for (const request of projectDetailRequestsRef.current.values()) request.controller.abort()
    projectDetailRequestsRef.current.clear()
  }, [])

  return {
    beginCitySelection,
    cancelProjectDetail,
    ensureProjectDetail,
    cityPreviewLoadingProjectId,
  }
}
