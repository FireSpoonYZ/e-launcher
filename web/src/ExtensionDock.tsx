import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Check } from 'lucide-react';
import type { ExtensionUiState, TodoTask } from './native';
import { shouldFollowTodo, todoScrollTarget, visibleTodoCount, visibleTodoTasks } from './extensionUI';
import { useText } from './ui';

export function ExtensionDock({conversationId, state}: {conversationId: string; state?: ExtensionUiState}) {
  const widgets = state?.widgets ?? [];
  const statuses = state?.statuses ?? [];
  const notifications = state?.notifications ?? [];
  const todoOwned = state?.todo?.package === '@juicesharp/rpiv-todo';
  const genericWidgets = widgets.filter(widget => !(todoOwned && widget.key === 'rpiv-todos'));
  if (!state) return null;
  return <section className="extension-dock" aria-label="Extension status">
    {genericWidgets.map(widget => <pre className={`extension-widget ${widget.placement}`} key={widget.key}>{widget.lines.join('\n')}</pre>)}
    <TodoProgress conversationId={conversationId} todo={state.todo}/>
    {statuses.map(status => <div className="extension-status" role="status" key={status.key}>{status.text}</div>)}
    {notifications.map(notification => <div className={`extension-notification ${notification.type}`} role="status" aria-live="polite" key={notification.id}>{notification.message}</div>)}
  </section>;
}

function TodoProgress({conversationId, todo}: {conversationId: string; todo: ExtensionUiState['todo']}) {
  const t = useText();
  const tasks = visibleTodoTasks(todo);
  const activeIndex = tasks.findIndex(task => task.status === 'in_progress');
  const activeId = activeIndex < 0 ? null : String(tasks[activeIndex].id);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const activeByConversation = useRef(new Map<string, string|null>());
  const seenConversations = useRef(new Set<string>());
  const currentConversation = useRef(conversationId);
  const drag = useRef<{pointerId:number; startX:number; startLeft:number; native:boolean}|null>(null);
  const nativeSettling = useRef(false);
  const settleTimer = useRef<number|undefined>(undefined);
  const settleGeneration = useRef(0);
  const pendingFollow = useRef(false);
  const latestFollow = useRef<() => void>(() => {});
  const [dragging, setDragging] = useState(false);

  const followActive = useCallback(() => {
    const element = scroll.current;
    if (!element || activeIndex < 0) return;
    const item = element.querySelector<HTMLElement>(`[data-task-index="${activeIndex}"]`);
    if (!item) return;
    const target = todoScrollTarget(activeIndex, item.offsetWidth, element.scrollWidth, element.clientWidth);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({left:target, behavior:reducedMotion ? 'auto' : 'smooth'});
    positions.current.set(conversationId, target);
  }, [activeIndex, conversationId]);
  latestFollow.current = followActive;

  const cancelSettle = useCallback(() => {
    settleGeneration.current++;
    window.clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    nativeSettling.current = false;
  }, []);
  const resetInteraction = useCallback(() => {
    cancelSettle();
    const currentDrag = drag.current;
    drag.current = null;
    if (currentDrag && scroll.current?.hasPointerCapture(currentDrag.pointerId)) {
      scroll.current.releasePointerCapture(currentDrag.pointerId);
    }
    pendingFollow.current = false;
    setDragging(false);
  }, [cancelSettle]);
  const settleNativeScroll = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    nativeSettling.current = true;
    const generation = ++settleGeneration.current;
    const owner = conversationId;
    settleTimer.current = window.setTimeout(() => {
      if (settleGeneration.current !== generation || currentConversation.current !== owner) return;
      settleTimer.current = undefined;
      nativeSettling.current = false;
      if (!drag.current && pendingFollow.current) {
        pendingFollow.current = false;
        latestFollow.current();
      }
    }, 160);
  }, [conversationId]);
  useEffect(() => () => {
    settleGeneration.current++;
    window.clearTimeout(settleTimer.current);
    drag.current = null;
    nativeSettling.current = false;
    pendingFollow.current = false;
  }, []);

  useLayoutEffect(() => {
    if (currentConversation.current !== conversationId) {
      resetInteraction();
      currentConversation.current = conversationId;
    }
    const element = scroll.current;
    if (!element) {
      resetInteraction();
      seenConversations.current.add(conversationId);
      activeByConversation.current.set(conversationId, null);
      return;
    }
    element.scrollLeft = positions.current.get(conversationId) ?? 0;
    const seen = seenConversations.current.has(conversationId);
    const previous = activeByConversation.current.get(conversationId) ?? null;
    if (shouldFollowTodo(seen, previous, activeId)) {
      if (drag.current || nativeSettling.current) pendingFollow.current = true;
      else followActive();
    } else if (activeId === null) {
      pendingFollow.current = false;
    }
    seenConversations.current.add(conversationId);
    activeByConversation.current.set(conversationId, activeId);
  }, [conversationId, activeId, tasks.length, followActive, resetInteraction]);

  if (tasks.length === 0) return null;
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const native = drag.current.native;
    drag.current = null;
    setDragging(false);
    if (native) {
      settleNativeScroll();
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pendingFollow.current) {
      pendingFollow.current = false;
      latestFollow.current();
    }
  };
  return <div className="todo-progress" aria-label={t('任务进度','Task progress')}>
    <div className={`todo-scroll${dragging ? ' dragging' : ''}`} ref={scroll} tabIndex={0}
      onScroll={event => {
        positions.current.set(conversationId, event.currentTarget.scrollLeft);
        if (nativeSettling.current) settleNativeScroll();
      }}
      onPointerDown={event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        cancelSettle();
        if (event.pointerType !== 'mouse') {
          drag.current = {pointerId:event.pointerId, startX:event.clientX, startLeft:event.currentTarget.scrollLeft, native:true};
          return;
        }
        drag.current = {pointerId:event.pointerId, startX:event.clientX, startLeft:event.currentTarget.scrollLeft, native:false};
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        if (!drag.current || drag.current.pointerId !== event.pointerId || drag.current.native) return;
        event.preventDefault();
        event.currentTarget.scrollLeft = drag.current.startLeft - (event.clientX - drag.current.startX);
        positions.current.set(conversationId, event.currentTarget.scrollLeft);
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
      <ol className="todo-track" role="list" style={{'--todo-visible-count':visibleTodoCount(tasks.length)} as CSSProperties}>
        {tasks.map((task, index) => <TodoNode task={task} index={index} key={task.id}/>)}
      </ol>
    </div>
  </div>;
}

function TodoNode({task, index}: {task: TodoTask; index: number}) {
  const t = useText();
  const status = task.status === 'completed' ? t('已完成','Completed')
    : task.status === 'in_progress' ? t('执行中','In progress') : t('待处理','Pending');
  return <li className={`todo-node ${task.status}`} data-task-index={index} aria-label={`${status}: ${task.subject}`}>
    <span className="todo-marker" aria-hidden="true">{task.status === 'completed' && <Check/>}</span>
    <span className="todo-subject">{task.subject}</span>
  </li>;
}
