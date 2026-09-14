import assert from "node:assert/strict";
import test from "node:test";
import {
  todoScrollTarget,
  visibleTodoTasks,
  visibleTodoCount,
  shouldFollowTodo,
} from "../src/extensionUI.ts";

const task = (id, status, subject = `task ${id}`) => ({ id, status, subject });

test("todo visibility keeps source order and hides only deleted tasks while work remains", () => {
  const tasks = [task(1, "completed"), task(2, "deleted"), task(3, "in_progress"), task(4, "pending")];
  assert.deepEqual(visibleTodoTasks({ tasks, nextId:5 }).map((item) => item.id), [1, 3, 4]);
  assert.deepEqual(visibleTodoTasks({ tasks:[task(1, "completed"), task(2, "deleted")], nextId:3 }), [],
    "empty and all-complete lists hide the panel");
  assert.deepEqual(visibleTodoTasks({ tasks:[task(5, "pending")], nextId:6 }).map((item) => item.id), [5],
    "new pending work makes a previously hidden panel visible again");
});

test("todo viewport exposes at most three equal slots", () => {
  assert.equal(visibleTodoCount(1), 1);
  assert.equal(visibleTodoCount(2), 2);
  assert.equal(visibleTodoCount(3), 3);
  assert.equal(visibleTodoCount(8), 3);
});

test("active todo scroll target prefers the second slot and clamps at both ends", () => {
  assert.equal(todoScrollTarget(0, 100, 600, 300), 0);
  assert.equal(todoScrollTarget(1, 100, 600, 300), 0);
  assert.equal(todoScrollTarget(3, 100, 600, 300), 200);
  assert.equal(todoScrollTarget(5, 100, 600, 300), 300);
});

test("automatic following runs only on first active task or active-task changes", () => {
  assert.equal(shouldFollowTodo(false, null, "1"), true);
  assert.equal(shouldFollowTodo(true, "1", "1"), false);
  assert.equal(shouldFollowTodo(true, "1", "2"), true);
  assert.equal(shouldFollowTodo(true, "1", null), false, "no active task preserves manual position");
});
