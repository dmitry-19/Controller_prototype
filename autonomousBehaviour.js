// js/autonomousBehaviour.js
// Инстинктивные реакции персонажа на основе Utility AI,
// субъективного состояния (PerceivedCondition), памяти (EpisodicMemory)
// и доверия к игроку (TrustModel).

export class AutonomousBehaviour {
    constructor(scene, characterRoot, krl, perceptionSystem, staminaSystem, healthSystem, movementSystem, episodicMemory, perceivedCondition, trustModel) {
        this.scene = scene;
        this.characterRoot = characterRoot;
        this.krl = krl;                       // KinematicRagdollLayer (управляет позами через activatePose)
        this.perception = perceptionSystem;
        this.stamina = staminaSystem;
        this.health = healthSystem;
        this.movement = movementSystem;
        this.memory = episodicMemory;
        this.perceived = perceivedCondition;
        this.trust = trustModel;

        this.fearLevel = 0;
        this.fearDecayRate = 0.3;
        this.fearIncreaseRate = 0.4;

        this.currentAction = 'none';
        this._lastActionScore = 0;
        this._actionLockTimer = 0;
        this._actionLockTime = 0.5;

        this._idleTimer = 0;
        this._lastInputTime = performance.now() / 1000;

        this.actions = [
            'idle_alert',
            'block_hand',
            'dodge',
            'retreat',
            'freeze',
            'twitch',
            'sanctuary_pull'
        ];

        this.TRUST_THRESHOLD = 0.5;
        this.FEAR_THRESHOLD = 0.6;
    }

    _sigmoid(x, x0, k = 5) {
        const t = k * (x - x0);
        return 1 / (1 + Math.exp(-t));
    }

    _invSigmoid(x, x0, k = 5) {
        return 1 - this._sigmoid(x, x0, k);
    }

    _scoreAction(action, ctx) {
        const { fearLevel, nearestThreat, perceivedHealthRatio, perceivedStaminaRatio, trust, sanctuaryDistance } = ctx;

        let dist = nearestThreat ? nearestThreat.distance : 999;
        let telegraph = nearestThreat ? nearestThreat.telegraphProgress : 0;
        let damageZone = nearestThreat ? nearestThreat.damageZone : 'any';
        let subtype = nearestThreat ? nearestThreat.subtype : 'generic';
        const fearBonus = this.memory.getFearBonus(subtype);

        let score = 1.0;

        switch (action) {
            case 'idle_alert':
                score *= this._sigmoid(fearLevel, 0.05, 10);
                score *= this._invSigmoid(fearLevel, 0.25, 10);
                score *= this._invSigmoid(dist, 8, 2);
                break;

            case 'block_hand':
                if (trust < this.TRUST_THRESHOLD || fearLevel > this.FEAR_THRESHOLD) {
                    score = 0;
                } else {
                    score *= this._sigmoid(fearLevel, 0.2, 8);
                    score *= this._invSigmoid(fearLevel, 0.6, 8);
                    score *= this._invSigmoid(dist, 2.5, 4);
                    score *= this._sigmoid(telegraph, 0.2, 10);
                    if (damageZone === 'head') score *= 1.5;
                    if (damageZone === 'torso') score *= 1.2;
                    if (perceivedStaminaRatio < 0.3) score *= 0.4;
                    score *= (0.5 + trust * 0.5);
                }
                break;

            case 'dodge':
                score *= this._sigmoid(fearLevel, 0.3, 8);
                score *= this._invSigmoid(fearLevel, 0.7, 8);
                score *= this._invSigmoid(dist, 2.0, 5);
                score *= this._sigmoid(telegraph, 0.15, 8);
                if (damageZone === 'leg' || damageZone === 'head') score *= 1.3;
                score *= this._sigmoid(perceivedStaminaRatio, 0.3, 8);
                break;

            case 'retreat':
                if (trust < this.TRUST_THRESHOLD || fearLevel > this.FEAR_THRESHOLD) {
                    score = 0;
                } else {
                    score *= this._sigmoid(fearLevel, 0.5, 8);
                    score *= this._invSigmoid(perceivedHealthRatio, 0.4, 6);
                    score *= this._sigmoid(perceivedStaminaRatio, 0.2, 6);
                    score *= (1 - trust * 0.5);
                }
                break;

            case 'freeze':
                score *= this._sigmoid(fearLevel, 0.85, 12);
                score *= this._invSigmoid(perceivedHealthRatio, 0.2, 10);
                score *= 1.5;
                break;

            case 'twitch':
                score *= this._invSigmoid(fearLevel, 0.4, 6);
                score *= fearBonus > 0.3 ? 2.0 : 0.3;
                if (this._idleTimer < 2) score *= 0.1;
                break;

            case 'sanctuary_pull':
                if (trust < this.TRUST_THRESHOLD || fearLevel > this.FEAR_THRESHOLD) {
                    score = 0;
                } else {
                    score *= this._sigmoid(fearLevel, 0.4, 8);
                    score *= this._invSigmoid(sanctuaryDistance, 4, 2);
                    score *= (1 - trust * 0.6);
                }
                break;

            default:
                score = 0;
        }
        return score;
    }

    update(deltaSec, playerInputActive) {
        if (window.gameplayMode !== 2) {
            this.fearLevel = Math.max(0, this.fearLevel - this.fearDecayRate * deltaSec);
            return;
        }

        if (!this.perception.snapshot) return;

        const snapshot = this.perception.snapshot;
        const now = performance.now() / 1000;

        if (playerInputActive) {
            this._lastInputTime = now;
        }
        this._idleTimer = now - this._lastInputTime;

        this.memory.update(deltaSec);

        let maxFear = 0;
        let nearestThreat = null;
        for (const t of snapshot.threats) {
            const distFactor = Math.max(0, 1 - t.distance / this.perception.mediumRadius);
            const fearBonus = this.memory.getFearBonus(t.subtype);
            const threatFear = t.fearIntensity * 0.15 * distFactor + fearBonus * distFactor;
            if (threatFear > maxFear) {
                maxFear = threatFear;
                nearestThreat = t;
            }
        }

        for (const p of snapshot.projectiles) {
            const distFactor = Math.max(0, 1 - p.distance / this.perception.farRadius);
            const projFear = p.speed * 0.05 * distFactor;
            if (projFear > maxFear) {
                maxFear = projFear;
                nearestThreat = {
                    direction: p.direction,
                    distance: p.distance,
                    subtype: 'projectile',
                    damageZone: 'any',
                    isAttacking: true,
                    telegraphProgress: 1,
                    fearIntensity: 4
                };
            }
        }

        if (maxFear > this.fearLevel) {
            this.fearLevel = Math.min(1.0, this.fearLevel + this.fearIncreaseRate * deltaSec * (1 + maxFear));
        } else {
            this.fearLevel = Math.max(0.0, this.fearLevel - this.fearDecayRate * deltaSec);
        }

        const playerPushingTowardDanger = this._isPlayerPushingToDanger(nearestThreat);
        const isSafe = this._isInSanctuary(snapshot);
        this.trust.update(deltaSec, isSafe, playerPushingTowardDanger);

        if (this._actionLockTimer > 0) {
            this._actionLockTimer -= deltaSec;
            return;
        }

        const ctx = {
            fearLevel: this.fearLevel,
            nearestThreat,
            perceivedHealthRatio: this.perceived.getHealthRatio(),
            perceivedStaminaRatio: this.perceived.getStaminaRatio(),
            trust: this.trust.getTrust(),
            sanctuaryDistance: snapshot.sanctuaries.length > 0 ? snapshot.sanctuaries[0].distance : 999
        };

        let bestAction = 'none';
        let bestScore = 0;
        for (const action of this.actions) {
            const score = this._scoreAction(action, ctx);
            if (score > bestScore) {
                bestScore = score;
                bestAction = action;
            }
        }

        if (bestAction !== this.currentAction && bestAction !== 'none') {
            console.log(`[Autonomous] action: ${bestAction} (score: ${bestScore.toFixed(2)}), fear: ${this.fearLevel.toFixed(2)}, trust: ${this.trust.getTrust().toFixed(2)}`);
            this._actionLockTimer = this._actionLockTime;
        }

        this._applyAction(bestAction, ctx);
        this.currentAction = bestAction;
        this._lastActionScore = bestScore;
    }

    _isPlayerPushingToDanger(nearestThreat) {
        if (!nearestThreat) return false;
        const moveState = this.movement.getMovementState();
        if (!moveState.isMoving) return false;
        const moveDir = new BABYLON.Vector3(moveState.moveX, 0, moveState.moveY).normalize();
        const toThreat = nearestThreat.direction.scale(-1);
        const dot = BABYLON.Vector3.Dot(moveDir, toThreat);
        return dot > 0.3 && nearestThreat.distance < 5;
    }

    _isInSanctuary(snapshot) {
        for (const s of snapshot.sanctuaries) {
            if (s.distance < 2.5) return true;
        }
        return false;
    }

    // ----------------------------------------------------------------
    // Применение действий (используем новый API KRL)
    // ----------------------------------------------------------------
    _applyAction(action, ctx) {
        // Сброс всех KRL‑целей (руки и голова)
        if (this.krl) {
            this.krl.deactivatePose();   // обе руки
            this.krl.clearBoneTarget('pelvis');
            this.krl.clearBoneTarget('spine_03');
            this.krl.setLookTarget(null);
        }
        this.movement.isEvading = false;

        const { nearestThreat } = ctx;

        switch (action) {
            case 'idle_alert':
                this._applyAlert(nearestThreat);
                break;
            case 'block_hand':
                this._applyBlock(nearestThreat);
                break;
            case 'dodge':
                this._applyDodge(nearestThreat);
                this.movement.isEvading = true;
                break;
            case 'retreat':
                this._applyRetreat(nearestThreat);
                this.movement.isEvading = true;
                break;
            case 'freeze':
                this._applyFreeze();
                break;
            case 'twitch':
                this._applyNervousTwitch();
                break;
            case 'sanctuary_pull':
                this._applySanctuaryPull(ctx);
                break;
            default:
                this.movement.externalSpeedLimit = 1.0;
                break;
        }
    }

    _applyAlert(threat) {
        // Без смещений корпуса, чтобы не мешать игроку
    }

    _applyFreeze() {
        // Физика сама застынет — никаких команд
    }

    _applyRetreat(threat) {
        if (!threat) return;
        const retreatDir = threat.direction.scale(-1);
        this.movement.externalBias.addInPlace(retreatDir.scale(0.3));
        this.movement.externalSpeedLimit = 0.8;
    }

    _applyDodge(threat) {
        if (!threat) return;
        const dodgeDir = new BABYLON.Vector3(-threat.direction.z, 0, threat.direction.x);
        this.movement.externalBias.addInPlace(dodgeDir.scale(0.4));
        this.movement.externalSpeedLimit = 0.85;
    }

    _applyBlock(threat) {
        if (!threat) return;
        const side = threat.direction.x < 0 ? 'r' : 'l';
        // Активируем позу блокирования головы
        this.krl.activatePose(`block_head_${side}`);
        // Вторую руку слегка поднимаем
        const otherSide = side === 'r' ? 'l' : 'r';
        this.krl.activatePose(`block_torso_${otherSide}`);
    }

    _applyNervousTwitch() {

    }

    _applySanctuaryPull(ctx) {
        if (!ctx.nearestThreat) return;
        const sanctuary = this.perception.snapshot?.sanctuaries?.[0];
        if (!sanctuary) return;
        const pullDir = sanctuary.direction;
        this.movement.externalBias.addInPlace(pullDir.scale(0.3));
        this.movement.externalSpeedLimit = 0.9;
    }

    recordDanger(hostileSubtype, attackPattern, damageZone, damage) {
        this.memory.addEvent('damage', {
            subtype: hostileSubtype,
            pattern: attackPattern,
            zone: damageZone,
            force: damage
        });
        const fearBonus = this.memory.getFearBonus(hostileSubtype);
        this.perceived.applyDamage(damage, damageZone, this.fearLevel, fearBonus);
        this.trust.recordDamage(damage);
    }

    dispose() {
        this.krl = null;
        this.perception = null;
    }
}