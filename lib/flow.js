'use strict';

// Flow cards for the controls Homey does not make cards for itself.
//
// **Homey generates cards only for its own capabilities**, so `onoff` and `dim`
// have them and the speed, direction and timer pickers and the light's buttons
// do not. The definitions are in `.homeycompose/flow/`, written for every device
// at once and narrowed to the drivers that have the control by each card's
// `driver_id` filter.

// A capability that holds a state, and the cards that go with it. `arg` is the
// name the cards give their dropdown.
const STATE_CARDS = {
    lucci_speed: { id: 'fan_speed', arg: 'speed' },
    lucci_direction: { id: 'fan_direction', arg: 'direction' },
    lucci_timer: { id: 'fan_timer', arg: 'timer' },
};

// A button, and the card that presses it.
const BUTTON_ACTIONS = {
    toggle_light: 'lucci_toggle',
    light_brighter: 'lucci_brighter',
    light_dimmer: 'lucci_dimmer',
    change_fan_direction: 'lucci_reverse',
};

function registerFlowCards(homey) {
    for (const [capability, { id, arg }] of Object.entries(STATE_CARDS)) {
        // The trigger names the one value it fires for, as Homey's own enum
        // triggers do, so matching is the picked value against the fired one.
        homey.flow.getDeviceTriggerCard(`${id}_changed`)
            .registerRunListener(async (args, state) => args[arg] === state.value);

        homey.flow.getConditionCard(`${id}_is`)
            .registerRunListener(async args => args.device.getCapabilityValue(capability) === args[arg]);

        homey.flow.getActionCard(`set_${id}`)
            .registerRunListener(async args => setState(args.device, capability, args[arg]));
    }

    for (const [card, capability] of Object.entries(BUTTON_ACTIONS)) {
        homey.flow.getActionCard(card)
            .registerRunListener(async args => args.device.triggerCapabilityListener(capability, true));
    }
}

// What the tile does when someone picks a value, because a Flow is the same
// request. The listener transmits; the write is the part Homey does for a tile
// and would not do for a card, so it is done here after the send has not thrown.
//
// Speed goes to `onCapabilities` directly rather than through
// `triggerCapabilityListener`: that listener is the coupled one, registered
// with a debounce for a dragged picker, and a card is one request that has
// nothing to pool.
async function setState(device, capability, value) {
    if (capability === 'lucci_speed') await device.onCapabilities({ lucci_speed: value });
    else await device.triggerCapabilityListener(capability, value);

    await device.setCapabilityValue(capability, value);
}

// Fires the trigger for a state that has just changed. Not awaited by callers:
// a Flow that fails must not make a change the fan has already made look as if
// it failed.
//
// Called from the two places a value comes from, which is a request Homey made
// and a press the handset made, and only when the value actually differs, so a
// press heard twice or a request repeated fires once. Capabilities without a
// card are ignored, which lets a caller not care which ones have one.
function announceChange(device, capability, value) {
    const card = STATE_CARDS[capability];
    if (card === undefined) return;

    device.homey.flow.getDeviceTriggerCard(`${card.id}_changed`)
        .trigger(device, {}, { value })
        .catch(err => device.error(`flow trigger ${card.id}_changed failed:`, err.message));
}

module.exports = { registerFlowCards, announceChange, STATE_CARDS, BUTTON_ACTIONS };
