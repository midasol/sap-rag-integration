import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStatus,
  resetStatus,
  updateStatus,
  addLog,
} from '../pipeline-state';

describe('pipeline-state', () => {
  beforeEach(() => {
    resetStatus(0);
  });

  it('getStatus returns a snapshot copy, not the live object', () => {
    resetStatus(5);
    const snap = getStatus();
    snap.completed = 999;
    expect(getStatus().completed).toBe(0);
  });

  it('resetStatus initializes counters and sets running=true', () => {
    resetStatus(7);
    expect(getStatus()).toMatchObject({
      running: true,
      total: 7,
      completed: 0,
      succeeded: 0,
      failed: 0,
      currentFile: '',
      logs: [],
    });
  });

  it('updateStatus partially merges fields', () => {
    resetStatus(3);
    updateStatus({ currentFile: 'foo.txt', completed: 1 });
    expect(getStatus()).toMatchObject({
      currentFile: 'foo.txt',
      completed: 1,
      total: 3,
    });
  });

  it('addLog prepends entries (newest first) and caps at 100', () => {
    resetStatus(0);
    for (let i = 0; i < 105; i++) {
      addLog({ fileName: `f${i}`, status: 'success', duration: i });
    }
    const status = getStatus();
    expect(status.logs).toHaveLength(100);
    expect(status.logs[0]).toMatchObject({ fileName: 'f104' });
    expect(status.logs[99]).toMatchObject({ fileName: 'f5' });
  });

  // SPRINT 3 GUARD (B-6): the read-then-write pattern in pipeline routes
  // currently loses concurrent updates. Sprint 3 introduces atomic counter
  // helpers (incrementCompleted / incrementSucceeded / incrementFailed) and
  // un-skips this test.
  it.skip('concurrent increments do not lose updates (B-6 fix in Sprint 3)', () => {
    resetStatus(2);
    const a = getStatus();
    const b = getStatus();
    updateStatus({ completed: a.completed + 1 });
    updateStatus({ completed: b.completed + 1 });
    expect(getStatus().completed).toBe(2); // currently observes 1 → bug
  });
});
