import { describe, expect, it } from 'vitest';
import { validateProject, newProject } from '@3dmm/project';
describe('cyclic project', () => {
  it('is rejected with an actionable message, not a RangeError', () => {
    const p: any = newProject('x');
    const a: any = { id: 'a', kind: 'group', name: 'a', visible: true, locked: false, opacity: 1, children: [] };
    a.children = [a];
    p.layers = [a];
    const v = validateProject(p);
    console.log('ok=', v.ok, 'issues=', JSON.stringify(v.issues));
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'cycle')).toBe(true);
  });
  it('still accepts a valid deep tree', () => {
    const p: any = newProject('x');
    let cur: any = { id: 'n0', kind: 'group', name: 'n0', visible: true, locked: false, opacity: 1, children: [] };
    p.layers = [cur];
    for (let i = 1; i < 500; i++) {
      const child: any = { id: `n${i}`, kind: 'group', name: `n${i}`, visible: true, locked: false, opacity: 1, children: [] };
      cur.children = [child];
      cur = child;
    }
    const v = validateProject(p);
    expect(v.ok).toBe(true);
  });
});

describe('validateProject — invariants zod cannot express', () => {
  it('rejects a duplicate layer id', () => {
    const p: any = newProject('x');
    const mk = (id: string): any => ({ id, kind: 'group', name: id, visible: true, locked: false, opacity: 1, children: [] });
    p.layers = [mk('dup'), mk('dup')];
    const v = validateProject(p);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'duplicate_id')).toBe(true);
  });

  it('rejects a dangling panorama neighbour reference', () => {
    const p: any = newProject('x');
    p.panorama.nodes = [
      {
        id: 'n1',
        name: 'One',
        position: { x: 0, y: 0, z: 0 },
        headingDeg: 0,
        image: 'a.jpg',
        neighbors: { north: 'ghost' },
      },
    ];
    const v = validateProject(p);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'dangling_ref')).toBe(true);
  });

  it('returns the parsed project when the document is valid', () => {
    const v = validateProject(newProject('ok'));
    expect(v.ok).toBe(true);
    expect(v.project).not.toBeNull();
    expect(v.issues).toEqual([]);
  });

  it('reports a schema failure with the offending path', () => {
    const v = validateProject({ schemaVersion: 6, id: '', name: 5 });
    expect(v.ok).toBe(false);
    expect(v.project).toBeNull();
    expect(v.issues.length).toBeGreaterThan(0);
    expect(v.issues.every((i) => typeof i.path === 'string')).toBe(true);
  });
});
