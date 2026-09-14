import type { TodoSnapshot, TodoTask } from './native';

export function visibleTodoTasks(todo?: TodoSnapshot|null): TodoTask[] {
  const tasks = todo?.tasks.filter(task => task.status !== 'deleted') ?? [];
  return tasks.some(task => task.status !== 'completed') ? tasks : [];
}

export function visibleTodoCount(count: number): number {
  return Math.min(3, Math.max(1, count));
}

export function todoScrollTarget(activeIndex: number, itemWidth: number, scrollWidth: number, clientWidth: number): number {
  return Math.max(0, Math.min(activeIndex * itemWidth - itemWidth, scrollWidth - clientWidth));
}

export function shouldFollowTodo(seen: boolean, previousActiveId: string|null, nextActiveId: string|null): boolean {
  return nextActiveId !== null && (!seen || previousActiveId !== nextActiveId);
}
