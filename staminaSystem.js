// js/staminaSystem.js
export class StaminaSystem {
    constructor(options = {}) {
        this.maxStamina = options.maxStamina ?? 100;
        this.currentStamina = options.initialStamina ?? this.maxStamina;

        // Расход в секунду
        this.runCost = options.runCost ?? 12;
        this.walkCost = options.walkCost ?? 0;
        this.crouchCost = options.crouchCost ?? 0;

        // Единоразовые затраты
        this.jumpCost = options.jumpCost ?? 20;
        this.attackCost = options.attackCost ?? 8;
        this.blockCost = options.blockCost ?? 6;
        this.turnCost = options.turnCost ?? 5;
        this.stumbleCost = options.stumbleCost ?? 15;

        // Восстановление в секунду
        this.regenRateIdle = options.regenRateIdle ?? 15;
        this.regenRateMoving = options.regenRateMoving ?? 5;

        // Пороги эффектов
        this.lowStaminaThreshold = options.lowStaminaThreshold ?? 25;
        this.exhaustedThreshold = options.exhaustedThreshold ?? 10;

        // Множители при низкой стамине
        this.speedMultiplierLow = 0.7;
        this.damageMultiplierLow = 0.7;
        this.pdStrengthLow = 0.7;
        this.pdStrengthExhausted = 0.5;

        // Флаги
        this.isExhausted = false;
        this.isLow = false;
    }

    update(deltaSec, isMoving, isRunning, isCrouching) {
        if (isMoving) {
            let cost = this.walkCost;
            if (isRunning) cost = this.runCost;
            else if (isCrouching) cost = this.crouchCost;
            this.currentStamina = Math.max(0, this.currentStamina - cost * deltaSec);
        }

        if (!isMoving && this.currentStamina < this.maxStamina) {
            this.currentStamina = Math.min(this.maxStamina, this.currentStamina + this.regenRateIdle * deltaSec);
        } else if (isMoving && !isRunning && this.currentStamina < this.maxStamina) {
            this.currentStamina = Math.min(this.maxStamina, this.currentStamina + this.regenRateMoving * deltaSec);
        }

        this.isLow = this.currentStamina <= this.lowStaminaThreshold;
        this.isExhausted = this.currentStamina <= this.exhaustedThreshold;
    }

    consume(amount) {
        this.currentStamina = Math.max(0, this.currentStamina - amount);
        this.isLow = this.currentStamina <= this.lowStaminaThreshold;
        this.isExhausted = this.currentStamina <= this.exhaustedThreshold;
    }

    consumeByImpact(force) {
        const impactCost = Math.min(30, force * 0.5);
        this.consume(impactCost);
    }

    canPerformAction(cost = 1) {
        return this.currentStamina >= cost;
    }

    getSpeedMultiplier() {
        if (this.isExhausted) return 0.5;
        if (this.isLow) return this.speedMultiplierLow;
        return 1.0;
    }

    getDamageMultiplier() {
        if (this.isExhausted) return 0.4;
        if (this.isLow) return this.damageMultiplierLow;
        return 1.0;
    }

    getPdStrengthMultiplier() {
        if (this.isExhausted) return this.pdStrengthExhausted;
        if (this.isLow) return this.pdStrengthLow;
        return 1.0;
    }

    getNormalized() {
        return this.currentStamina / this.maxStamina;
    }
}