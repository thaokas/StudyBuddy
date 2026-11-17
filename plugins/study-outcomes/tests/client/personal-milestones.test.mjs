import assert from 'node:assert/strict';
import { it } from 'node:test';
import { installReactStub } from './support/react-stub.mjs';
installReactStub();
const { PersonalMilestonesView } = await import('../../client/components/personal-milestones.js');
const dictionary = (await import('../../client/messages/outcomes.js')).default;
const create = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null) });
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean);
it('shows confirmed evidence and lets students define and remove milestones in both languages', () => {
  for (const lang of ['zh', 'en']) {
    let saved = false, removed = null;
    const tree = PersonalMilestonesView({ create, t: key => { assert.ok(dictionary[lang][key], key); return dictionary[lang][key]; },
      view: { title: '阶段成果', selected: ['a'], busy: false, tasks: [{ id: 'a', title: 'A' }], items: [{ id: 'm', title: '第三章', completed: 1, total: 1, earned: true, earnedAt: '2026-11-15', evidence: [{ taskId: 'a', recordId: 2, date: '2026-11-15' }] }] },
      onSave: () => { saved = true; }, onDelete: id => { removed = id; }, onTitle: () => {}, onToggle: () => {},
    });
    const form = find(tree, node => node.type === 'form'); form.props.onSubmit({ preventDefault() {} });
    assert.equal(saved, true);
    find(tree, node => node.type === 'button' && node.props.type === 'button').props.onClick();
    assert.equal(removed, 'm');
    assert.ok(find(tree, node => node.type === 'details'));
  }
});
