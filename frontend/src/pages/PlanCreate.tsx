import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { agentApi, connectPlannerSSE } from '@/api/agent'
import { planApi } from '@/api'
import type { FoundationLevel, SseEventType, SearchResultItem, GeneratedTask, PlannerMaterial, SseMessageData, SseSearchResultsData, SseConfirmData, SsePlanGeneratedData, SseStateData } from '@/types'
import dayjs from 'dayjs'

let msgIdCounter = 1

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  time: string
  planId?: string
  planName?: string
}

interface TimelineCard {
  id: number
  afterMessageId: number
  type: 'materials' | 'confirm'
}

const GREETING_MESSAGE =
  '你好！我是你的小搭\n\n你可以直接告诉我你想备考什么考试，我会帮你搜索相关信息，了解你的情况，然后为你量身定制一份专属备考计划。\n\n比如你可以说：\n\n• "我想备考2027年考研数学一"\n\n• "帮我制定雅思A类的备考计划"\n\n• "我在准备CPA会计科目的考试"'

export default function PlanCreate() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: msgIdCounter++,
      role: 'assistant',
      content: GREETING_MESSAGE,
      time: dayjs().format('HH:mm'),
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [planGenerated, setPlanGenerated] = useState(false)

  // SSE-driven UI state
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([])
  const [confirmProfile, setConfirmProfile] = useState<Record<string, unknown> | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generatedTasks, setGeneratedTasks] = useState<GeneratedTask[]>([])
  const [materials, setMaterials] = useState<PlannerMaterial[]>([])
  const [timelineCards, setTimelineCards] = useState<TimelineCard[]>([])
  const [materialError, setMaterialError] = useState<string | null>(null)
  const [materialUploading, setMaterialUploading] = useState(false)
  const [showLinkInput, setShowLinkInput] = useState(false)
  const [linkInput, setLinkInput] = useState('')

  // Multi-turn state — carried across SSE calls
  const stateRef = useRef<Record<string, unknown> | null>(null)
  const threadIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastAssistantMessageIdRef = useRef<number | null>(messages[0]?.id ?? null)

  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, timelineCards, materials, searchResults])

  const addTimelineCard = useCallback((type: TimelineCard['type']) => {
    const afterMessageId = lastAssistantMessageIdRef.current
    if (!afterMessageId) return
    setTimelineCards((prev) => [
      ...prev.filter((card) => !(card.afterMessageId === afterMessageId && card.type === type)),
      { id: msgIdCounter++, afterMessageId, type },
    ])
  }, [])

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'time'>) => {
    const id = msgIdCounter++
    const message = { ...msg, id, time: dayjs().format('HH:mm') }
    if (msg.role === 'assistant') {
      lastAssistantMessageIdRef.current = id
    }
    setMessages((prev) => [...prev, message])
    return id
  }, [])

  const syncMaterialsToState = useCallback((nextMaterials: PlannerMaterial[]) => {
    stateRef.current = {
      ...(stateRef.current ?? {}),
      materials: nextMaterials,
    }
  }, [])

  const persistPlan = useCallback(async (tasks: GeneratedTask[], profile: Record<string, unknown>) => {
    try {
      const planRes = await planApi.createWithTasks({
        examName: (profile.exam_name as string) || '考试',
        examType: (profile.exam_type as string) || '',
        examDate: (profile.exam_date as string) || dayjs().add(30, 'day').format('YYYY-MM-DD'),
        dailyHours: (profile.daily_hours as number) || 2,
        foundationLevel: ((profile.foundation_level as number) ?? 1) as FoundationLevel,
        weakSubjects: (profile.weak_subjects as string[]) || [],
        currentMode: 0,
        tasks,
      })
      return planRes.data.data
    } catch {
      throw new Error('plan_save_failed')
    }
  }, [])

  const handleSseEvent = useCallback((event: string, data: unknown) => {
    switch (event as SseEventType) {
      case 'message': {
        const msg = data as SseMessageData
        addMessage({ role: 'assistant', content: msg.content })
        break
      }

      case 'search_start':
        // Could show a "searching..." indicator
        break

      case 'search_results': {
        const sr = data as SseSearchResultsData
        setSearchResults(sr.results)
        addTimelineCard('materials')
        break
      }

      case 'confirm': {
        const cf = data as SseConfirmData
        setConfirmProfile(cf.profile as unknown as Record<string, unknown>)
        if (cf.materials) {
          setMaterials(cf.materials)
          syncMaterialsToState(cf.materials)
        }
        if (cf.search_results) {
          setSearchResults(cf.search_results)
        }
        addTimelineCard('confirm')
        break
      }

      case 'plan_generating':
        setGenerating(true)
        break

      case 'plan_generated': {
        const pg = data as SsePlanGeneratedData
        setGeneratedTasks(pg.tasks)
        setGenerating(false)

        // Persist plan to backend
        persistPlan(pg.tasks, pg.profile)
          .then((plan) => {
            setPlanGenerated(true)
            addMessage({
              role: 'assistant',
              content: pg.summary,
              planId: plan.planId,
              planName: `已生成 ${pg.tasks.length} 个学习任务`,
            })
          })
          .catch(() => {
            addMessage({
              role: 'assistant',
              content: pg.summary + '\n\n⚠️ 计划保存失败，请稍后重试。',
            })
          })
        break
      }

      case 'state': {
        const st = data as SseStateData
        stateRef.current = {
          stage: st.stage,
          profile: st.profile,
          search_results: st.search_results,
          materials: st.materials ?? materials,
          search_signature: st.search_signature,
          plan_tasks: st.plan_tasks,
          messages: st.messages,
          search_done: st.search_done,
        }
        setMaterials(st.materials ?? materials)
        break
      }

      case 'done':
        setLoading(false)
        break

      case 'error': {
        const err = data as { message: string }
        addMessage({ role: 'assistant', content: `抱歉，出错了：${err.message}` })
        setLoading(false)
        setGenerating(false)
        break
      }
    }
  }, [addMessage, addTimelineCard, materials, persistPlan, syncMaterialsToState])

  const handleSseError = useCallback((error: string) => {
    console.error('SSE error:', error)
    addMessage({ role: 'assistant', content: '抱歉，连接出现异常，请稍后再试。' })
    setLoading(false)
    setGenerating(false)
  }, [addMessage])

  const handleSseComplete = useCallback(() => {
    setLoading(false)
  }, [])

  const handleSend = useCallback(async (text?: string) => {
    const msg = (text ?? input.trim())
    if (!msg || loading || planGenerated) return

    addMessage({ role: 'user', content: msg })
    if (!text) setInput('')
    setLoading(true)
    syncMaterialsToState(materials)

    abortRef.current = connectPlannerSSE(
      msg,
      threadIdRef.current,
      stateRef.current,
      handleSseEvent,
      handleSseError,
      handleSseComplete,
    )
  }, [input, loading, materials, planGenerated, addMessage, handleSseEvent, handleSseError, handleSseComplete, syncMaterialsToState])

  const handleConfirmGenerate = useCallback(() => {
    setGenerating(true)
    syncMaterialsToState(materials)

    // Send "确认" to trigger plan generation
    abortRef.current = connectPlannerSSE(
      '确认，请生成备考计划',
      threadIdRef.current,
      stateRef.current,
      (event, data) => {
        if (event === 'plan_generated') {
          const pg = data as SsePlanGeneratedData
          setGeneratedTasks(pg.tasks)
          setGenerating(false)
          persistPlan(pg.tasks, pg.profile)
            .then((plan) => {
              setPlanGenerated(true)
              addMessage({
                role: 'assistant',
                content: pg.summary,
                planId: plan.planId,
                planName: `已生成 ${pg.tasks.length} 个学习任务`,
              })
            })
            .catch(() => {
              addMessage({
                role: 'assistant',
                content: pg.summary + '\n\n⚠️ 计划保存失败，请稍后重试。',
              })
            })
        } else if (event === 'message') {
          const msg = data as SseMessageData
          addMessage({ role: 'assistant', content: msg.content })
        } else if (event === 'state') {
          const st = data as SseStateData
          stateRef.current = {
            stage: st.stage,
            profile: st.profile,
            search_results: st.search_results,
            materials: st.materials ?? materials,
            search_signature: st.search_signature,
            plan_tasks: st.plan_tasks,
            messages: st.messages,
            search_done: st.search_done,
          }
          setMaterials(st.materials ?? materials)
        } else if (event === 'error') {
          const err = data as { message: string }
          addMessage({ role: 'assistant', content: `抱歉，生成失败：${err.message}` })
          setGenerating(false)
        } else if (event === 'done') {
          setLoading(false)
        }
      },
      (error) => {
        console.error('SSE error during confirm:', error)
        addMessage({ role: 'assistant', content: '抱歉，生成过程中出现异常。' })
        setGenerating(false)
      },
      () => {
        setLoading(false)
      },
    )
  }, [addMessage, materials, persistPlan, syncMaterialsToState])

  const handleToggleSearchResult = useCallback((index: number) => {
    setSearchResults((prev) => {
      const next = [...prev]
      if (index >= 0 && index < next.length) {
        next[index] = { ...next[index], relevant: !next[index].relevant }
        if (stateRef.current) {
          stateRef.current = { ...stateRef.current, search_results: next }
        }
      }
      return next
    })
  }, [])

  const handleToggleMaterial = useCallback((id: string) => {
    setMaterials((prev) => {
      const next = prev.map((material) =>
        material.id === id ? { ...material, selected: !material.selected } : material,
      )
      syncMaterialsToState(next)
      return next
    })
  }, [syncMaterialsToState])

  const handleRemoveMaterial = useCallback((id: string) => {
    setMaterials((prev) => {
      const next = prev.filter((material) => material.id !== id)
      syncMaterialsToState(next)
      return next
    })
  }, [syncMaterialsToState])

  const handleFileSelected = useCallback(async (file: File | undefined) => {
    if (!file || materialUploading) return
    setMaterialUploading(true)
    setMaterialError(null)
    try {
      const response = await agentApi.parsePlannerFile(file)
      const material = response.data
      setMaterials((prev) => {
        const next = [...prev, material]
        syncMaterialsToState(next)
        return next
      })
      addTimelineCard('materials')
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : '资料解析失败，请稍后重试。')
    } finally {
      setMaterialUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [addTimelineCard, materialUploading, syncMaterialsToState])

  const handleAddLink = useCallback(async () => {
    const url = linkInput.trim()
    if (!url || materialUploading) return
    setMaterialUploading(true)
    setMaterialError(null)
    try {
      const response = await agentApi.parsePlannerLink(url)
      const material = response.data
      setMaterials((prev) => {
        const next = [...prev, material]
        syncMaterialsToState(next)
        return next
      })
      setLinkInput('')
      setShowLinkInput(false)
      addTimelineCard('materials')
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : '链接解析失败，请检查地址或稍后重试。')
    } finally {
      setMaterialUploading(false)
    }
  }, [addTimelineCard, linkInput, materialUploading, syncMaterialsToState])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleRestart = useCallback(() => {
    abortRef.current?.abort()
    stateRef.current = null
    threadIdRef.current = null
    setSearchResults([])
    setConfirmProfile(null)
    setGeneratedTasks([])
    setMaterials([])
    setTimelineCards([])
    setMaterialError(null)
    setShowLinkInput(false)
    setLinkInput('')
    setGenerating(false)
    setPlanGenerated(false)
    setMessages([
      {
        id: msgIdCounter++,
        role: 'assistant',
        content: '好的，让我们重新开始！请告诉我你想备考什么考试~',
        time: dayjs().format('HH:mm'),
      },
    ])
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  // Collect profile display info from confirmProfile or state
  const profile = confirmProfile || (stateRef.current?.profile as Record<string, unknown> | undefined)
  const hasProfileBar = profile && (profile.exam_name || profile.exam_date || profile.daily_hours != null) && !planGenerated

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)] landscape:h-[calc(100dvh-7rem)] landscape:max-w-4xl landscape:mx-auto landscape:w-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0 mb-2">
        <h1 className="text-lg font-bold text-gray-800">创建备考计划</h1>
        {messages.length > 1 && (
          <button
            onClick={handleRestart}
            className="text-xs text-gray-400 hover:text-gray-600 transition"
          >
            重新开始
          </button>
        )}
      </div>

      {/* Profile status bar */}
      {hasProfileBar && (
        <div className="flex-shrink-0 mb-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-blue-500 font-medium">已收集：</span>
            {Boolean(profile.exam_name) && (
              <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                {String(profile.exam_name)}{profile.exam_type ? `（${String(profile.exam_type)}）` : ''}
              </span>
            )}
            {Boolean(profile.exam_date) && (
              <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                考试：{String(profile.exam_date)}
              </span>
            )}
            {profile.daily_hours != null && (
              <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                每天{String(profile.daily_hours)}h
              </span>
            )}
            {profile.foundation_level != null && (
              <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                基础：{['零基础', '有一定基础', '基础较好'][Number(profile.foundation_level)] ?? '未知'}
              </span>
            )}
            {Array.isArray(profile.weak_subjects) && profile.weak_subjects.length > 0 && (
              <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                薄弱：{(profile.weak_subjects as string[]).join('、')}
              </span>
            )}
            {Array.isArray(profile.missing_fields) && profile.missing_fields.length > 0 && (
              <span className="text-xs text-amber-500 ml-1">
                还需：{(profile.missing_fields as string[]).join('、')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 py-2">
        {messages.map((msg) => (
          <div key={msg.id}>
            <div
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[82%] ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                } flex flex-col gap-1`}
              >
                {msg.role === 'assistant' && (
                  <span className="text-xs text-gray-400 px-1">
                    <img src="/logo.png" alt="小搭" className="w-5 h-5 inline-block align-middle" /> 小搭
                  </span>
                )}
                <div
                  className={`px-4 py-3 rounded-2xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-blue-500 text-white rounded-br-sm'
                      : 'bg-white text-gray-700 shadow-sm border border-gray-100 rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-800 prose-a:text-blue-500">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
                <span className="text-xs text-gray-300 px-1">{msg.time}</span>
              </div>
            </div>

            {/* Plan generated card */}
            {msg.planId && planGenerated && (
              <div className="flex justify-start mt-2">
                    <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-4 max-w-[85%] w-full">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">📋</span>
                    <div>
                      <p className="font-semibold text-green-800">
                        {msg.planName ?? '备考计划'}
                      </p>
                      <p className="text-xs text-green-600">AI 已为你量身定制</p>
                    </div>
                  </div>
                  <button
                    onClick={() => navigate(`/plans/${msg.planId}`)}
                    className="w-full bg-green-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-green-600 transition active:scale-[0.98]"
                  >
                    查看计划详情 →
                  </button>
                </div>
              </div>
            )}

            {timelineCards
              .filter((card) => card.afterMessageId === msg.id)
              .map((card) => (
                <div key={card.id} className="mt-2">
                  {card.type === 'materials' ? (
                    <MaterialsTimelineCard
                      materials={materials}
                      results={searchResults}
                      onToggleMaterial={handleToggleMaterial}
                      onRemoveMaterial={handleRemoveMaterial}
                      onToggleResult={handleToggleSearchResult}
                    />
                  ) : (
                    confirmProfile && !planGenerated && (
                      <ConfirmCard
                        profile={confirmProfile}
                        materials={materials}
                        searchResults={searchResults}
                        onConfirm={handleConfirmGenerate}
                        loading={generating}
                      />
                    )
                  )}
                </div>
              ))}
          </div>
        ))}

        {/* Loading indicator */}
        {loading && !generating && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-100 shadow-sm text-gray-400 text-sm px-4 py-3 rounded-2xl rounded-bl-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs">AI 正在思考</span>
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:0.3s]" />
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Generating indicator */}
        {generating && (
          <div className="flex justify-start">
            <div className="bg-green-50 border border-green-200 shadow-sm text-green-700 text-sm px-4 py-3 rounded-2xl rounded-bl-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs">正在生成专属备考计划</span>
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce [animation-delay:0.3s]" />
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!planGenerated && (
        <div className="flex-shrink-0 pt-3 border-t border-gray-100 space-y-2">
          {(materials.length > 0 || materialError || materialUploading) && (
            <div className="flex flex-wrap gap-2">
              {materials.map((material) => (
                <span
                  key={material.id}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                    material.selected
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-gray-50 text-gray-400'
                  }`}
                >
                  <button type="button" onClick={() => handleToggleMaterial(material.id)}>
                    {material.selected ? '已采用' : '已排除'}
                  </button>
                  <span className="max-w-32 truncate">{material.name}</span>
                  <button type="button" onClick={() => handleRemoveMaterial(material.id)} className="text-gray-400">
                    ×
                  </button>
                </span>
              ))}
              {materialUploading && (
                <span className="text-xs text-blue-500 bg-blue-50 border border-blue-100 rounded-full px-2.5 py-1">
                  资料解析中...
                </span>
              )}
              {materialError && (
                <span className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-full px-2.5 py-1">
                  {materialError}
                </span>
              )}
            </div>
          )}

          {showLinkInput && (
            <div className="flex gap-2">
              <input
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                placeholder="粘贴公开网页链接，例如 https://..."
                className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleAddLink}
                disabled={materialUploading || !linkInput.trim()}
                className="px-3 py-2 text-xs bg-blue-500 disabled:bg-blue-300 text-white rounded-xl"
              >
                解析链接
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.pptx,.xlsx,.txt,.md,.html,.htm"
              onChange={(e) => handleFileSelected(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || materialUploading}
              className="w-12 h-12 border border-gray-200 text-gray-500 rounded-2xl flex items-center justify-center hover:bg-gray-50 transition flex-shrink-0"
              title="上传图片或文档"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={() => setShowLinkInput((value) => !value)}
              disabled={loading || materialUploading}
              className="w-12 h-12 border border-gray-200 text-gray-500 rounded-2xl flex items-center justify-center hover:bg-gray-50 transition flex-shrink-0"
              title="添加网页链接"
            >
              链
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入你的备考需求..."
              rows={1}
              disabled={loading}
              className="flex-1 px-4 py-3 border border-gray-200 rounded-2xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 transition disabled:bg-gray-50"
            />
            <button
              onClick={() => handleSend()}
              disabled={loading || !input.trim()}
              className="w-12 h-12 bg-blue-500 disabled:bg-blue-300 text-white rounded-2xl flex items-center justify-center hover:bg-blue-600 transition flex-shrink-0 active:scale-95"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Restart button when plan is done */}
      {planGenerated && (
        <div className="flex-shrink-0 pt-3 border-t border-gray-100">
          <button
            onClick={handleRestart}
            className="w-full border-2 border-dashed border-gray-300 text-gray-400 py-3 rounded-2xl text-sm hover:border-blue-300 hover:text-blue-400 transition"
          >
            + 创建新的备考计划
          </button>
        </div>
      )}
    </div>
  )
}

function MaterialsTimelineCard({
  materials,
  results,
  onToggleMaterial,
  onRemoveMaterial,
  onToggleResult,
}: {
  materials: PlannerMaterial[]
  results: SearchResultItem[]
  onToggleMaterial: (id: string) => void
  onRemoveMaterial: (id: string) => void
  onToggleResult: (index: number) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  if (results.length === 0 && materials.length === 0) return null

  return (
    <div className="flex justify-start">
      <div className="bg-white border border-gray-100 shadow-sm rounded-2xl p-4 max-w-[88%] w-full">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">
              参考资料 ({materials.length + results.length} 条)
            </span>
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-xs text-blue-500 hover:text-blue-700 transition"
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          已解析的附件、链接和搜索证据会辅助计划生成；你可以排除不需要的条目。
        </p>
        {!collapsed && (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {materials.map((material) => (
              <div
                key={material.id}
                className={`flex items-start gap-2 p-2 rounded-lg text-xs border ${
                  material.selected
                    ? 'bg-blue-50 border-blue-100'
                    : 'bg-gray-50 border-gray-200 opacity-60'
                }`}
              >
                <button
                  onClick={() => onToggleMaterial(material.id)}
                  className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 transition ${
                    material.selected
                      ? 'border-blue-400 bg-blue-400 text-white'
                      : 'border-gray-300 bg-white text-gray-300'
                  }`}
                  title={material.selected ? '点击排除' : '点击恢复'}
                >
                  {material.selected ? '✓' : '×'}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-gray-800 truncate">{material.name}</p>
                    <button onClick={() => onRemoveMaterial(material.id)} className="text-gray-400 hover:text-red-500">
                      移除
                    </button>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-gray-600">{material.summary}</p>
                </div>
              </div>
            ))}
            {results.map((r, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 p-2 rounded-lg text-xs transition ${
                  r.relevant
                    ? 'bg-white border border-amber-100'
                    : 'bg-gray-100 border border-gray-200 opacity-50'
                }`}
              >
                <button
                  onClick={() => onToggleResult(i)}
                  className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 transition ${
                    r.relevant
                      ? 'border-blue-400 bg-blue-400 text-white'
                      : 'border-gray-300 bg-white text-gray-300'
                  }`}
                  title={r.relevant ? '点击排除' : '点击恢复'}
                >
                  {r.relevant ? '✓' : '✕'}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 mb-0.5">
                    {r.query_purpose && (
                      <span className="text-[10px] text-blue-600 bg-blue-50 rounded px-1.5 py-0.5">
                        {r.query_purpose}
                      </span>
                    )}
                    {r.source_quality && (
                      <span className="text-[10px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                        {r.source_quality}
                      </span>
                    )}
                  </div>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`font-medium hover:underline ${
                      r.relevant ? 'text-blue-600' : 'text-gray-400'
                    }`}
                  >
                    {r.title || '无标题'}
                  </a>
                  <p className={`mt-0.5 line-clamp-2 ${r.relevant ? 'text-gray-600' : 'text-gray-400'}`}>
                    {r.snippet}
                  </p>
                  {r.reason && (
                    <p className="mt-1 text-[10px] text-gray-400">{r.reason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Confirmation card */
function ConfirmCard({
  profile,
  materials,
  searchResults,
  onConfirm,
  loading,
}: {
  profile: Record<string, unknown>
  materials: PlannerMaterial[]
  searchResults: SearchResultItem[]
  onConfirm: () => void
  loading: boolean
}) {
  const examDate = profile.exam_date as string | undefined
  const daysUntilExam = examDate
    ? dayjs(examDate).diff(dayjs(), 'day')
    : null
  const foundationLevel = Number(profile.foundation_level ?? 1)
  const examSubjects = Array.isArray(profile.exam_subjects) ? profile.exam_subjects as string[] : []
  const weakSubjects = Array.isArray(profile.weak_subjects) ? profile.weak_subjects as string[] : []
  const restDays = profile.rest_days_per_week == null ? null : Number(profile.rest_days_per_week)
  const restDesc = restDays == null
    ? '待确认'
    : ['不固定休息', '周日休息', '周六、周日休息', '周五、周六、周日休息'][restDays] ?? `${restDays} 天`
  const adoptedMaterials = materials.filter((material) => material.selected)
  const adoptedResults = searchResults.filter((result) => result.relevant)

  return (
    <div className="flex justify-start">
      <div className="bg-white border border-blue-100 shadow-sm rounded-2xl p-4 max-w-[88%] w-full">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold text-gray-800">信息确认</span>
        </div>

        <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-3 mb-3 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-500">考试名称</span>
            <span className="text-gray-800 font-medium">
              {String(profile.exam_name || '')}{profile.exam_type ? `（${String(profile.exam_type)}）` : ''}
            </span>
          </div>
          {Boolean(profile.exam_date) && (
            <div className="flex justify-between">
              <span className="text-gray-500">考试日期</span>
              <span className="text-gray-800 font-medium">
                {String(profile.exam_date)}
                {daysUntilExam != null && (
                    <span className="text-blue-600 ml-1">
                    （距考试还有 {daysUntilExam} 天）
                  </span>
                )}
              </span>
            </div>
          )}
          {profile.daily_hours != null && (
            <div className="flex justify-between">
              <span className="text-gray-500">每日学习时间</span>
              <span className="text-gray-800 font-medium">{String(profile.daily_hours)} 小时</span>
            </div>
          )}
          {profile.foundation_level != null && (
            <div className="flex justify-between">
              <span className="text-gray-500">基础水平</span>
              <span className="text-gray-800 font-medium">
                {['零基础', '有一定基础', '基础较好'][foundationLevel]}
              </span>
            </div>
          )}
          {examSubjects.length > 0 && (
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">实际备考科目</span>
              <span className="text-gray-800 font-medium text-right">
                {examSubjects.join('、')}
              </span>
            </div>
          )}
          {weakSubjects.length > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-500">薄弱科目</span>
              <span className="text-gray-800 font-medium">
                {weakSubjects.join('、')}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-gray-500">每周休息</span>
            <span className="text-gray-800 font-medium">
              {restDays == null ? '待确认' : `${restDays} 天`}（{restDesc}）
            </span>
          </div>
          {(adoptedMaterials.length > 0 || adoptedResults.length > 0) && (
            <div className="pt-2 border-t border-blue-100">
              <p className="text-gray-500 mb-1">将采用的参考资料</p>
              <p className="text-gray-700">
                {[...adoptedMaterials.map((m) => m.name), ...adoptedResults.slice(0, 3).map((r) => r.title || r.url)].join('、')}
              </p>
            </div>
          )}
        </div>

        <button
          onClick={onConfirm}
          disabled={loading}
          className="w-full bg-blue-500 disabled:bg-blue-300 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-600 transition active:scale-[0.98] flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <span>正在生成专属备考计划...</span>
            </>
          ) : (
            '确认无误，生成备考计划 →'
          )}
        </button>
        <p className="text-xs text-gray-400 mt-2 text-center">
          如需修改，请在下方输入框中说明需要调整的内容
        </p>
      </div>
    </div>
  )
}
