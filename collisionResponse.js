// js/collisionResponse.js
import { STATE_NAMES } from './stateMachine.js';

export class CollisionResponseHandler {
    constructor(stateMachine, movementSystem, staminaSystem) {
        this.stateMachine = stateMachine;
        this.movement = movementSystem;
        this.stamina = staminaSystem;
    }

    handleImpact(collisionData, speed, tier) {
        const force = collisionData.force || speed * 5;

        // Расход выносливости от удара о статику
        if (this.stamina) {
            this.stamina.consumeByImpact(force);
        }

        const effectiveTier = (tier === 'medium' && this.stamina?.isExhausted) ? 'high' : tier;

        if (effectiveTier === 'medium') {
            this.stateMachine.transitionTo(STATE_NAMES.STUMBLE, {
                direction: collisionData.normal,
                force: force,
                contactPoint: collisionData.point
            });
        } else if (effectiveTier === 'high') {
            this.stateMachine.transitionTo(STATE_NAMES.RAGDOLL_IMPACT, {
                direction: collisionData.normal,
                force: force * 1.5,
                contactPoint: collisionData.point
            });
        }
        this.movement.setInputLock(true);
    }
}