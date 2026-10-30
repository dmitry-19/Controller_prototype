// js/stateMachine.js
export const STATE_NAMES = {
    IDLE: 'idle',
    MOVE: 'move',
    ACTION: 'action',
    IMPACT: 'impact',
    STRUGGLE: 'struggle',
    KNOCKDOWN: 'knockdown',
    GET_UP: 'getUp',
    RAGDOLL: 'ragdoll',
    DEFEND: 'defend',
    STUMBLE: 'stumble',
    RAGDOLL_IMPACT: 'ragdollImpact'
};

class State {
    constructor(name) {
        this.name = name;
        this.machine = null;
        this.lockUpper = false;
        this.lockLower = false;
        this.statePdFactor = null;
    }
    onEnter(prevState, ...args) {}
    onExit(nextState) {}
    update(deltaTime) {}
    transitionTo(newStateName, ...args) {
        if (this.machine) this.machine.transitionTo(newStateName, ...args);
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class IdleState extends State {
    onEnter(prevState) {
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = 1.0;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
    }
    update(deltaTime) {
        if (this.machine.movementSystem && this.machine.movementSystem.getMovementState().isMoving) {
            this.transitionTo(STATE_NAMES.MOVE);
        }
    }
    getDesiredUpper() {
        // При низкой выносливости показываем Dizzy
        if (this.machine.staminaSystem?.isLow) return 'Dizzy';
        return null;
    }
}

export class MoveState extends State {
    getDesiredLower() {
        const moveState = this.machine.movementSystem.getMovementState();
        const isLow = this.machine.staminaSystem?.isLow;
        // Передаём в менеджер анимаций флаг усталости через stressLevel (временно переиспользуем аргумент)
        return this.machine.animManager.getDesiredLowerFromMovement(moveState, isLow ? 60 : 0);
    }
    getDesiredUpper() {
        const isLow = this.machine.staminaSystem?.isLow;
        const weaponDrawn = false; // здесь оружие не учитываем
        return this.machine.animManager.getDesiredUpperFromState(this.name, isLow ? 60 : 0, weaponDrawn);
    }
    onEnter(prevState) {
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = 1.0;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
    }
    update(deltaTime) {
        if (!this.machine.movementSystem.getMovementState().isMoving) {
            this.transitionTo(STATE_NAMES.IDLE);
        }
    }
}

export class ActionState extends State {
    onEnter(prevState, animName, fullBody) {
        this.lockUpper = true;
        this.lockLower = fullBody;
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(fullBody);
        this.statePdFactor = 1.0;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
        this.machine.animManager.startAction(animName, fullBody, () => {
            if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
            this.transitionTo(STATE_NAMES.IDLE);
        });
    }
    onExit(nextState) {
        if (this.machine.animManager) this.machine.animManager.resetActions();
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = null;
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class ImpactState extends State {
    onEnter(prevState, impactData) {
        const { level, hitZone, force } = impactData;
        let animName = null;
        if (level === 1) animName = 'Shivering';
        else if (level === 2) animName = hitZone === 'head' ? 'Hit_Head' : 'Hit_Chest';
        else if (level === 3) animName = 'Hit_Knockback';

        if (animName && (this.machine.animManager.upper[animName] || this.machine.animManager.lower[animName])) {
            const fullBody = level >= 3 || animName === 'Hit_Knockback';
            this.lockUpper = true;
            this.lockLower = fullBody;
            if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(fullBody);
            this.statePdFactor = 0.7;
            this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
            this.machine.animManager.startAction(animName, fullBody, () => {
                if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
                this.transitionTo(STATE_NAMES.IDLE);
            });
        } else {
            this.waitTimer = 0.2;
        }
    }
    onExit(nextState) {
        if (this.machine.animManager) this.machine.animManager.resetActions();
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = null;
    }
    update(deltaTime) {
        if (this.waitTimer !== undefined) {
            this.waitTimer -= deltaTime;
            if (this.waitTimer <= 0) {
                delete this.waitTimer;
                this.transitionTo(STATE_NAMES.IDLE);
            }
        }
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class StruggleState extends State {
    onEnter(prevState) {
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = 0.7;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
    }
    getDesiredUpper() {
        return 'Dizzy';
    }
    getDesiredLower() {
        const moveState = this.machine.movementSystem.getMovementState();
        if (moveState.hasVelocity) {
            return 'Zombie_Walk_Fwd_Loop';
        } else {
            return 'Tired_Hunched';
        }
    }
    update(deltaTime) {
        // Выходим из Struggle, когда выносливость восстановилась
        if (this.machine.staminaSystem && !this.machine.staminaSystem.isLow) {
            this.transitionTo(STATE_NAMES.IDLE);
        }
    }
    onExit(nextState) {
        this.statePdFactor = null;
    }
}

export class KnockdownState extends State {
    onEnter(prevState) {
        this.lockUpper = true;
        this.lockLower = true;
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(true);
        this.statePdFactor = 0.0;
        this.machine.pdStrengthTarget = 0.0;

        if (this.machine.animManager.upper['Death01']) {
            const deathAnim = this.machine.animManager.upper['Death01'];
            const duration = deathAnim.length;
            this.machine.animManager.startAction('Death01', true, null);
            this.ragdollTimer = Math.max(0, duration - 0.3);
        } else {
            this.transitionTo(STATE_NAMES.RAGDOLL, true);
        }
    }
    onExit(nextState) {
        if (this.machine.animManager) this.machine.animManager.resetActions();
        this.statePdFactor = null;
    }
    update(deltaTime) {
        if (this.ragdollTimer !== undefined) {
            this.ragdollTimer -= deltaTime;
            if (this.ragdollTimer <= 0) {
                this.transitionTo(STATE_NAMES.RAGDOLL, true);
            }
        }
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class GetUpState extends State {
    onEnter(prevState) {
        this.lockUpper = true;
        this.lockLower = true;
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(true);
        this.machine.pdStrength = 1.0;
        this.statePdFactor = 1.0;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;

        const animName = 'LayToIdle';
        if (this.machine.animManager.upper[animName] || this.machine.animManager.lower[animName]) {
            this.machine.animManager.startAction(animName, true, () => {
                if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
                this.transitionTo(STATE_NAMES.IDLE);
            }, { disableBlending: true, lockBase: true });
        } else {
            console.warn("GetUpState: анимация LayToIdle не найдена, переход в IDLE");
            if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
            this.transitionTo(STATE_NAMES.IDLE);
        }
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class RagdollState extends State {
    onEnter(prevState, autoGetUp = false) {
        this.lockUpper = true;
        this.lockLower = true;
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(true);
        this.statePdFactor = 0.0;
        this.machine.pdStrength = 0.0;
        this.machine.pdStrengthTarget = 0.0;
        this.machine.animManager.stopAll();
        this.machine.animManager.resetActions();
        if (this.machine.dynamicMesh) this.machine.dynamicMesh.alwaysSelectAsActiveMesh = true;

        const pelvisBody = this.machine.boneBodyMap?.get('pelvis') ||
                           (this.machine.boneBodyMap ? Array.from(this.machine.boneBodyMap.values())[0] : null);
        if (pelvisBody) {
            const randomDir = new BABYLON.Vector3(
                (Math.random() - 0.5) * 0.5,
                Math.random() * 0.3,
                (Math.random() - 0.5) * 0.5
            ).normalize();
            const force = randomDir.scale(5);
            const worldPos = pelvisBody.transformNode.getAbsolutePosition();
            pelvisBody.applyImpulse(force, worldPos);
        }
        if (autoGetUp) {
            this.getUpTimer = 2.5;
        } else {
            this.getUpTimer = null;
        }
    }
    update(deltaTime) {
        if (this.getUpTimer !== null) {
            this.getUpTimer -= deltaTime;
            if (this.getUpTimer <= 0) {
                this.transitionTo(STATE_NAMES.GET_UP);
            }
        }
    }
    onExit() {
        if (this.machine.dynamicMesh) this.machine.dynamicMesh.alwaysSelectAsActiveMesh = false;
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = null;
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class DefendState extends State {
    onEnter(prevState, hitDirection, collisionSpeed = 2.0) {
        this.lockUpper = true;
        this.lockLower = false;
        this.hitDirection = hitDirection ? hitDirection.clone() : new BABYLON.Vector3(1, 0, 0);
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(true);
        this.statePdFactor = 1.0;
        this.machine.pdStrengthTarget = this.machine.getBasePdTarget() * this.statePdFactor;
        this.backwardDistance = Math.min(2.0, 0.5 + collisionSpeed * 0.3);
        this.moveDuration = Math.min(0.5, 0.2 + collisionSpeed * 0.1);
        this.moveTimer = this.moveDuration;
        this.startPos = this.machine.movementSystem.position.clone();
        this.targetPos = this.startPos.add(this.hitDirection.scale(this.backwardDistance));
        this.isMoving = true;
    }
    getDesiredUpper() { return 'Defend'; }
    getDesiredLower() {
        const moveState = this.machine.movementSystem.getMovementState();
        const isLow = this.machine.staminaSystem?.isLow;
        return this.machine.animManager.getDesiredLowerFromMovement(moveState, isLow ? 60 : 0);
    }
    update(deltaTime) {
        if (this.isMoving) {
            this.moveTimer -= deltaTime;
            let t = 1.0 - Math.max(0, this.moveTimer / this.moveDuration);
            t = 1 - Math.pow(1 - t, 3);
            const newPos = BABYLON.Vector3.Lerp(this.startPos, this.targetPos, t);
            this.machine.movementSystem.position.copyFrom(newPos);
            this.machine.movementSystem.root.position.copyFrom(newPos);
            if (this.moveTimer <= 0) {
                this.isMoving = false;
                this.idleTimer = 0.2;
            }
        } else if (this.idleTimer !== undefined) {
            this.idleTimer -= deltaTime;
            if (this.idleTimer <= 0) {
                this.transitionTo(STATE_NAMES.IDLE);
            }
        }
    }
    onExit() {
        if (this.machine.movementSystem) this.machine.movementSystem.setInputLock(false);
        this.statePdFactor = null;
    }
}

export class StumbleState extends State {
    onEnter(prevState, impactData) {
        this.lockUpper = true;
        this.lockLower = true;
        if (this.machine.movementSystem) {
            this.machine.movementSystem.setInputLock(true);
            this.machine.movementSystem.isReactingToCollision = true;
        }
        const basePd = this.machine.getBasePdTarget();
        this.statePdFactor = 0.3;
        this.machine.pdStrengthTarget = basePd * this.statePdFactor;

        if (this.machine.staminaSystem) this.machine.staminaSystem.consume(15);

        let animName = 'Hit_Chest';
        const force = impactData.force || 20;
        const direction = impactData.direction || new BABYLON.Vector3(0, 0, 1);
        const dotForward = BABYLON.Vector3.Dot(direction, new BABYLON.Vector3(0, 0, 1));
        if (force > 40) animName = 'Hit_Knockback';
        else if (Math.abs(dotForward) < 0.5) animName = 'Hit_Head';
        else if (dotForward > 0.7) animName = 'Hit_Chest';
        else animName = 'Dizzy';

        this.machine.animManager.startAction(animName, true, () => {
            this.transitionTo(STATE_NAMES.IDLE);
        }, { disableBlending: true });

        if (this.machine.reactionSystem && direction) {
            const pelvisBody = this.machine.boneBodyMap?.get('pelvis');
            if (pelvisBody) {
                const impulse = direction.scale(-force * 0.5);
                pelvisBody.applyImpulse(impulse, pelvisBody.transformNode.getAbsolutePosition());
            }
        }
        if (this.machine.camera) {
            const originalPos = this.machine.camera.position.clone();
            const shakeAmount = 0.15;
            this.machine.camera.position.addInPlace(new BABYLON.Vector3(
                (Math.random() - 0.5) * shakeAmount,
                (Math.random() - 0.5) * shakeAmount,
                (Math.random() - 0.5) * shakeAmount
            ));
            setTimeout(() => this.machine.camera.position.copyFrom(originalPos), 150);
        }
    }
    onExit(nextState) {
        if (this.machine.movementSystem) {
            this.machine.movementSystem.resetCollisionState();
            this.machine.movementSystem.isReactingToCollision = false;
        }
        this.statePdFactor = null;
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class RagdollImpactState extends State {
    onEnter(prevState, impactData) {
        this.lockUpper = true;
        this.lockLower = true;
        if (this.machine.movementSystem) {
            this.machine.movementSystem.setInputLock(true);
            this.machine.movementSystem.isReactingToCollision = true;
            this.machine.movementSystem.setKinematicColliderActive(false);
        }
        this.statePdFactor = 0.0;
        this.machine.pdStrengthTarget = 0.0;
        this.machine.animManager.stopAll();
        this.machine.animManager.resetActions();

        if (this.machine.staminaSystem) this.machine.staminaSystem.consume(35);

        const force = impactData.force || 50;
        const direction = impactData.direction || new BABYLON.Vector3(0, 0, 1);
        const pelvisBody = this.machine.boneBodyMap?.get('pelvis');
        const spineBody = this.machine.boneBodyMap?.get('spine_03');
        const headBody = this.machine.boneBodyMap?.get('head');
        if (pelvisBody && direction) {
            const impulse = direction.scale(-force * 0.8);
            pelvisBody.applyImpulse(impulse, pelvisBody.transformNode.getAbsolutePosition());
        }
        if (spineBody && direction) {
            const impulse = direction.scale(-force * 0.4);
            spineBody.applyImpulse(impulse, spineBody.transformNode.getAbsolutePosition());
        }
        if (headBody && direction) {
            const randomDir = new BABYLON.Vector3(
                (Math.random() - 0.5) * 0.5, Math.random() * 0.3, (Math.random() - 0.5) * 0.5
            ).normalize();
            const impulse = direction.scale(-force * 0.2).add(randomDir.scale(force * 0.1));
            headBody.applyImpulse(impulse, headBody.transformNode.getAbsolutePosition());
        }
        if (this.machine.camera) {
            const originalPos = this.machine.camera.position.clone();
            const shakeAmount = 0.3;
            this.machine.camera.position.addInPlace(new BABYLON.Vector3(
                (Math.random() - 0.5) * shakeAmount,
                (Math.random() - 0.5) * shakeAmount,
                (Math.random() - 0.5) * shakeAmount
            ));
            setTimeout(() => this.machine.camera.position.copyFrom(originalPos), 200);
        }
        this.getUpTimer = 2.5;
    }
    update(deltaTime) {
        const pelvisBody = this.machine.boneBodyMap?.get('pelvis');
        if (pelvisBody && this.machine.movementSystem) {
            const worldPos = pelvisBody.transformNode.getAbsolutePosition();
            worldPos.y = Math.max(worldPos.y, this.machine.movementSystem.groundY);
            this.machine.movementSystem.position.copyFrom(worldPos);
        }
        if (this.getUpTimer) {
            this.getUpTimer -= deltaTime;
            if (this.getUpTimer <= 0) {
                this.transitionTo(STATE_NAMES.GET_UP);
            }
        }
    }
    onExit(nextState) {
        if (this.machine.movementSystem) {
            this.machine.movementSystem.resetCollisionState();
            this.machine.movementSystem.isReactingToCollision = false;
            this.machine.movementSystem.setKinematicColliderActive(true);
        }
        this.statePdFactor = null;
        if (this.machine.staminaSystem) {
            this.machine.movementSystem.movement.maxWalkSpeed *= 0.7;
            this.machine.movementSystem.movement.maxRunSpeed *= 0.7;
            setTimeout(() => {
                this.machine.movementSystem.movement.maxWalkSpeed /= 0.7;
                this.machine.movementSystem.movement.maxRunSpeed /= 0.7;
            }, 5000);
        }
    }
    getDesiredUpper() { return null; }
    getDesiredLower() { return null; }
}

export class StateMachine {
    constructor() {
        this.states = {};
        this.currentState = null;
        this.pdStrength = 1.0;
        this.pdStrengthTarget = 1.0;
        this.staminaSystem = null;
    }
    getBasePdTarget() {
        return this.staminaSystem ? this.staminaSystem.getPdStrengthMultiplier() : 1.0;
    }
    addState(state) {
        this.states[state.name] = state;
        state.machine = this;
    }
    start(initialStateName) {
        this.currentState = this.states[initialStateName];
        if (this.currentState) this.currentState.onEnter(null);
    }
    transitionTo(newStateName, ...args) {
        const newState = this.states[newStateName];
        if (!newState) {
            console.warn(`State ${newStateName} not found`);
            return;
        }
        if (this.currentState && this.currentState.name === newStateName) {
            return;
        }
        const oldState = this.currentState;
        if (oldState) oldState.onExit(newState);
        this.currentState = newState;
        newState.onEnter(oldState, ...args);
        console.log(`Transition: ${oldState?.name} -> ${newState.name}`);
    }
    update(deltaTime) {
        if (this.currentState) this.currentState.update(deltaTime);
    }
}