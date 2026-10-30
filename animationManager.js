// js/animationManager.js
export class AnimationManager {
    constructor(upperAnimGroups, lowerAnimGroups) {
        this.upper = upperAnimGroups;
        this.lower = lowerAnimGroups;

        this.currentUpperBase = null;
        this.currentLowerBase = null;

        this.forcedUpper = null;
        this.forcedLower = null;

        this.upperAction = null;
        this.lowerAction = null;
        this.actionsPlayingCount = 0;

        this.lockBase = false;

        this._savedBlendingState = null;

        // 🆕 Скорости анимаций (по умолчанию 1.0)
        this.upperSpeed = 1.0;
        this.lowerSpeed = 1.0;
    }

    // Временное отключение/включение blending на сцене
    setGlobalBlending(enable) {
        const anyGroup = Object.values(this.upper)[0] || Object.values(this.lower)[0];
        if (!anyGroup) return;
        const scene = anyGroup._scene;
        if (!scene.animationPropertiesOverride) return;

        if (this._savedBlendingState === null) {
            this._savedBlendingState = {
                enableBlending: scene.animationPropertiesOverride.enableBlending,
                blendingSpeed: scene.animationPropertiesOverride.blendingSpeed
            };
        }

        scene.animationPropertiesOverride.enableBlending = enable;
        scene.animationPropertiesOverride.blendingSpeed = enable ? this._savedBlendingState.blendingSpeed : 0;
    }

    restoreBlending() {
        if (this._savedBlendingState === null) return;
        const anyGroup = Object.values(this.upper)[0] || Object.values(this.lower)[0];
        if (!anyGroup) return;
        const scene = anyGroup._scene;
        if (scene.animationPropertiesOverride) {
            scene.animationPropertiesOverride.enableBlending = this._savedBlendingState.enableBlending;
            scene.animationPropertiesOverride.blendingSpeed = this._savedBlendingState.blendingSpeed;
        }
        this._savedBlendingState = null;
    }

    // Остановка всех циклических анимаций
    stopAll() {
        this.stopUpperBase();
        this.stopLowerBase();
    }

    stopUpperBase() {
        if (this.currentUpperBase && this.upper[this.currentUpperBase]) {
            this.upper[this.currentUpperBase].stop();
            this.currentUpperBase = null;
        }
    }

    stopLowerBase() {
        if (this.currentLowerBase && this.lower[this.currentLowerBase]) {
            this.lower[this.currentLowerBase].stop();
            this.currentLowerBase = null;
        }
    }

    // 🆕 Новый метод для установки скорости анимаций
    setAnimationSpeed(upperSpeed, lowerSpeed) {
        this.upperSpeed = Math.max(0, upperSpeed);
        this.lowerSpeed = Math.max(0, lowerSpeed);

        // Применяем к текущим базовым анимациям
        if (this.currentUpperBase && this.upper[this.currentUpperBase]) {
            this.upper[this.currentUpperBase].speedRatio = this.upperSpeed;
        }
        if (this.currentLowerBase && this.lower[this.currentLowerBase]) {
            this.lower[this.currentLowerBase].speedRatio = this.lowerSpeed;
        }
    }

    // Новый метод для запуска верхней базовой анимации
    startUpperBase(animName) {
        if (!this.upper[animName]) {
            console.warn(`startUpperBase: анимация ${animName} не найдена`);
            return;
        }
        this._startBase('upper', animName);
    }

    setForcedUpper(animName) {
        if (this.forcedUpper === animName) return;
        this.forcedUpper = animName;
        if (animName && !this.lockBase) {
            this._startBase('upper', animName);
        }
    }

    setForcedLower(animName) {
        if (this.forcedLower === animName) return;
        this.forcedLower = animName;
        if (animName && !this.lockBase) {
            this._startBase('lower', animName);
        }
    }

    _startBase(part, animName) {
        const groups = part === 'upper' ? this.upper : this.lower;
        const current = part === 'upper' ? this.currentUpperBase : this.currentLowerBase;
        const group = groups[animName];
        if (!group) return;

        if (current && groups[current]) {
            groups[current].stop();
        }

        // 🆕 Применяем текущую скорость анимации
        const speedRatio = part === 'upper' ? this.upperSpeed : this.lowerSpeed;
        group.start(true, speedRatio, group.from, group.to, false);

        if (part === 'upper') {
            this.currentUpperBase = animName;
        } else {
            this.currentLowerBase = animName;
        }
    }

    resetActions() {
        if (this.upperAction) {
            this.upperAction.stop();
            this.upperAction = null;
        }
        if (this.lowerAction) {
            this.lowerAction.stop();
            this.lowerAction = null;
        }
        this.actionsPlayingCount = 0;
    }

    // Запуск одноразового действия
    startAction(animName, fullBody, onEnd, options = {}) {
        const { disableBlending = false, lockBase = false } = options;
        if (!this.upper[animName] && !this.lower[animName]) {
            console.warn(`startAction: анимация ${animName} не найдена`);
            return;
        }

        this.resetActions();
        this.stopAll();

        if (lockBase) {
            this.lockBase = true;
        }

        if (disableBlending) {
            this.setGlobalBlending(false);
        }

        if (this.upper[animName]) {
            this.currentUpperBase = null;
        }
        if (fullBody && this.lower[animName]) {
            this.currentLowerBase = null;
        }

        let count = 0;
        const onOneEnd = () => {
            count--;
            if (count === 0) {
                if (disableBlending) {
                    this.restoreBlending();
                }
                if (lockBase) {
                    this.lockBase = false;
                }
                if (onEnd) onEnd();
                this.resetActions();
            }
        };

        // 🆕 Для действий тоже применяем скорость (но не меньше 0.5 для читаемости)
        const actionSpeed = Math.max(0.5, part => part === 'upper' ? this.upperSpeed : this.lowerSpeed);

        if (this.upper[animName]) {
            this.upperAction = this.upper[animName];
            this.upperAction.onAnimationGroupEndObservable.addOnce(onOneEnd);
            this.upperAction.start(false, Math.max(0.5, this.upperSpeed), this.upperAction.from, this.upperAction.to, false);
            count++;
        }
        if (fullBody && this.lower[animName]) {
            this.lowerAction = this.lower[animName];
            this.lowerAction.onAnimationGroupEndObservable.addOnce(onOneEnd);
            this.lowerAction.start(false, Math.max(0.5, this.lowerSpeed), this.lowerAction.from, this.lowerAction.to, false);
            count++;
        }
        this.actionsPlayingCount = count;
    }

    // Логика выбора нижней анимации на основе движения и стресса
    getDesiredLowerFromMovement(moveState, stressLevel = 0) {
        if (!moveState.hasVelocity) {
            if (stressLevel > 50) {
                if (this.lower['Tired_Hunched']) return 'Tired_Hunched';
            }
            const idleCandidates = ['Idle_Loop', 'idle', 'standing_idle', 'Idle'];
            for (let name of idleCandidates) {
                if (this.lower[name]) return name;
            }
        } else {
            if (stressLevel > 50) {
                if (this.lower['Zombie_Walk_Fwd_Loop']) return 'Zombie_Walk_Fwd_Loop';
            }
            if (moveState.isCrouching) {
                const crouchCandidates = ['Crouch_Fwd_Loop', 'Crouch_Walk', 'crouch_forward'];
                for (let name of crouchCandidates) {
                    if (this.lower[name]) return name;
                }
            }
            if (moveState.isRunning) {
                const runCandidates = ['Sprint_Loop', 'Run Anime', 'Jog_Fwd_Loop', 'Running'];
                for (let name of runCandidates) {
                    if (this.lower[name]) return name;
                }
            }
            const walkCandidates = ['Walk_Loop', 'Walk_Formal_Loop', 'walk', 'Walking'];
            for (let name of walkCandidates) {
                if (this.lower[name]) return name;
            }
        }
        return null;
    }

    // Логика выбора верхней анимации на основе состояния и стресса
    getDesiredUpperFromState(stateName, stressLevel, weaponDrawn) {
        if (weaponDrawn && this.upper['Sword_Idle']) {
            return 'Sword_Idle';
        }
        if (stressLevel > 50 && this.upper['Dizzy']) {
            return 'Dizzy';
        }
        if (stateName === 'defend' && this.upper['Defend']) {
            return 'Defend';
        }
        return null;
    }

    // Установка базовых анимаций (циклических) – учитываем lockBase
    setBaseAnimations(desiredUpper, desiredLower) {
        if (this.lockBase) return;

        const upperToPlay = this.forcedUpper || desiredUpper;
        if (upperToPlay && this.upper[upperToPlay]) {
            if (upperToPlay !== this.currentUpperBase) {
                this._startBase('upper', upperToPlay);
            }
        } else if (!this.forcedUpper && desiredLower && this.upper[desiredLower]) {
            if (desiredLower !== this.currentUpperBase) {
                this._startBase('upper', desiredLower);
            }
        }

        const lowerToPlay = this.forcedLower || desiredLower;
        if (lowerToPlay && this.lower[lowerToPlay]) {
            if (lowerToPlay !== this.currentLowerBase) {
                this._startBase('lower', lowerToPlay);
            }
        }
    }
}