'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { registerFlowCards, announceChange, STATE_CARDS, BUTTON_ACTIONS } = require('../lib/flow');

const root = path.join(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const app = read('app.json');
const ids = kind => fs.readdirSync(path.join(root, '.homeycompose/flow', kind))
    .map(f => f.replace(/\.json$/, '')).sort();

// The three kinds of card, recording the run listener each was given.
function homeyStub() {
    const listeners = { triggers: {}, conditions: {}, actions: {} };
    const card = (kind, id) => ({ registerRunListener: fn => { listeners[kind][id] = fn; } });
    return {
        listeners,
        homey: {
            flow: {
                getDeviceTriggerCard: id => card('triggers', id),
                getConditionCard: id => card('conditions', id),
                getActionCard: id => card('actions', id),
            },
        },
    };
}

test('every card definition has a listener, and every listener a definition', () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);

    for (const kind of ['triggers', 'conditions', 'actions']) {
        assert.deepEqual(Object.keys(listeners[kind]).sort(), ids(kind), kind);
    }
});

test('app.json carries the cards', () => {
    for (const kind of ['triggers', 'conditions', 'actions']) {
        assert.deepEqual(app.flow[kind].map(c => c.id).sort(), ids(kind), kind);
    }
});

test('each card is offered only on drivers that have the capability it drives', () => {
    const capabilityOf = id => {
        for (const [capability, card] of Object.entries(STATE_CARDS)) {
            if (id === `${card.id}_changed` || id === `${card.id}_is` || id === `set_${card.id}`) return capability;
        }
        return BUTTON_ACTIONS[id];
    };
    const drivers = new Map(app.drivers.map(d => [d.id, d.capabilities]));

    for (const kind of ['triggers', 'conditions', 'actions']) {
        for (const card of app.flow[kind]) {
            const capability = capabilityOf(card.id);
            assert.ok(capability, `${card.id} drives a capability`);

            const filter = card.args.find(a => a.name === 'device').filter;
            const wanted = filter.replace('driver_id=', '').split('|');
            for (const id of wanted) {
                assert.ok(drivers.has(id), `${card.id} names driver ${id}, which exists`);
                assert.ok(drivers.get(id).includes(capability), `${card.id} on ${id}, which has ${capability}`);
            }

            // And the reverse: no driver with the capability is left out, which
            // is a card missing where a user would look for it.
            for (const [id, capabilities] of drivers) {
                if (capabilities.includes(capability)) {
                    // The standalone lights keep their own toggle listener and
                    // the combined fans a button; both are named in the filter.
                    assert.ok(wanted.includes(id), `${card.id} is offered on ${id}`);
                }
            }
        }
    }
});

test('every dropdown offers exactly the values its capability has', () => {
    for (const kind of ['triggers', 'conditions', 'actions']) {
        for (const card of app.flow[kind]) {
            for (const arg of card.args.filter(a => a.type === 'dropdown')) {
                const capability = Object.entries(STATE_CARDS).find(([, c]) => c.arg === arg.name)[0];
                const values = read(`.homeycompose/capabilities/${capability}.json`).values.map(v => v.id);
                assert.deepEqual(arg.values.map(v => v.id), values, `${card.id}.${arg.name}`);
            }
        }
    }
});

test('every card is titled in all four languages', () => {
    const complete = text => ['en', 'nl', 'de', 'fr'].every(l => typeof text?.[l] === 'string' && text[l] !== '');
    for (const kind of ['triggers', 'conditions', 'actions']) {
        for (const card of app.flow[kind]) {
            assert.ok(complete(card.title), `${card.id} title`);
            if (card.titleFormatted) assert.ok(complete(card.titleFormatted), `${card.id} titleFormatted`);
            if (card.hint) assert.ok(complete(card.hint), `${card.id} hint`);
            for (const arg of card.args.filter(a => a.type === 'dropdown')) {
                assert.ok(complete(arg.title), `${card.id} ${arg.name}`);
                for (const v of arg.values) assert.ok(complete(v.label), `${card.id} ${arg.name}=${v.id}`);
            }
        }
    }
});

test('a trigger matches the value picked, a condition reads the capability', async () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);

    assert.equal(await listeners.triggers.fan_speed_changed({ speed: '3' }, { value: '3' }), true);
    assert.equal(await listeners.triggers.fan_speed_changed({ speed: '3' }, { value: '4' }), false);

    const device = { getCapabilityValue: c => ({ lucci_direction: 'reverse' })[c] };
    assert.equal(await listeners.conditions.fan_direction_is({ device, direction: 'reverse' }), true);
    assert.equal(await listeners.conditions.fan_direction_is({ device, direction: 'forward' }), false);
});

test('setting a speed from a Flow transmits through the fan, then writes the value', async () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);
    const calls = [];
    const device = {
        onCapabilities: async values => calls.push(['onCapabilities', values]),
        setCapabilityValue: async (c, v) => calls.push(['set', c, v]),
        triggerCapabilityListener: async () => calls.push(['unexpected']),
    };

    await listeners.actions.set_fan_speed({ device, speed: '4' });
    assert.deepEqual(calls, [['onCapabilities', { lucci_speed: '4' }], ['set', 'lucci_speed', '4']]);
});

test('setting a direction or timer runs that capability\'s listener, then writes the value', async () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);
    const calls = [];
    const device = {
        triggerCapabilityListener: async (c, v) => calls.push(['listener', c, v]),
        setCapabilityValue: async (c, v) => calls.push(['set', c, v]),
    };

    await listeners.actions.set_fan_direction({ device, direction: 'reverse' });
    await listeners.actions.set_fan_timer({ device, timer: '2h' });
    assert.deepEqual(calls, [
        ['listener', 'lucci_direction', 'reverse'], ['set', 'lucci_direction', 'reverse'],
        ['listener', 'lucci_timer', '2h'], ['set', 'lucci_timer', '2h'],
    ]);
});

test('a failed transmission rejects the action and writes nothing', async () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);
    const written = [];
    const device = {
        triggerCapabilityListener: async () => { throw new Error('tx failed'); },
        setCapabilityValue: async (c, v) => written.push([c, v]),
    };

    await assert.rejects(listeners.actions.set_fan_timer({ device, timer: '2h' }), /tx failed/);
    assert.deepEqual(written, []);
});

test('each button card presses its capability once', async () => {
    const { homey, listeners } = homeyStub();
    registerFlowCards(homey);
    const pressed = [];
    const device = { triggerCapabilityListener: async (c, v) => pressed.push([c, v]) };

    for (const card of Object.keys(BUTTON_ACTIONS)) await listeners.actions[card]({ device });
    assert.deepEqual(pressed, Object.values(BUTTON_ACTIONS).map(c => [c, true]));
});

test('announceChange fires the trigger with the value, and ignores capabilities without a card', () => {
    const fired = [];
    const device = {
        homey: { flow: { getDeviceTriggerCard: id => ({ trigger: async (d, t, s) => fired.push([id, s.value]) }) } },
        error: () => {},
    };

    announceChange(device, 'lucci_timer', '8h');
    announceChange(device, 'onoff', true);
    assert.deepEqual(fired, [['fan_timer_changed', '8h']]);
});
