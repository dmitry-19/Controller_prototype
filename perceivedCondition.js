// js/perceivedCondition.js
export class PerceivedCondition {
    constructor(healthSystem, staminaSystem) {
        this.health = healthSystem;
        this.stamina = staminaSystem;
        this.perceivedHealth = healthSystem.currentHealth;
        this.perceivedStamina = staminaSystem.currentStamina;
        this._driftSpeed = 3.0; // ускорено
        this._psychFactors = {
            head: 1.8,
            torso: 1.2,
            arm: 0.9,
            leg: 0.8,
            pelvis: 1.3
        };
    }

    applyDamage(realDamage, zone, fearLevel, memoryBonus) {
        const factor = this._psychFactors[zone] || 1.0;
        const perceivedDamage = realDamage * (1 + fearLevel * 0.5 + memoryBonus * 0.3) * factor; // чуть снижено
        this.perceivedHealth = Math.max(0, this.perceivedHealth - perceivedDamage);
        this.perceivedStamina = Math.max(0, this.perceivedStamina - perceivedDamage);
        console.log(`[Perceived] real dmg ${realDamage.toFixed(1)} (${zone}) -> felt ${perceivedDamage.toFixed(1)}, health felt ${this.perceivedHealth.toFixed(1)}`);
    }

    update(deltaSec) {
        // Основной дрейф к реальному здоровью
        this.perceivedHealth += (this.health.currentHealth - this.perceivedHealth) * this._driftSpeed * deltaSec;
        this.perceivedStamina += (this.stamina.currentStamina - this.perceivedStamina) * this._driftSpeed * deltaSec;

        // Психологическая адаптация: ускоренный рост ощущаемого здоровья, если реальное выше
        if (this.perceivedHealth < this.health.currentHealth - 0.05 * this.health.maxHealth) {
            this.perceivedHealth += 1.5 * deltaSec; // усилено
        }
    }

    getHealthRatio() {
        return this.perceivedHealth / this.health.maxHealth;
    }

    getStaminaRatio() {
        const maxStamina = this.health.getMaxStamina();
        return this.perceivedStamina / maxStamina;
    }

    isLowHealth() {
        return this.getHealthRatio() < 0.25;
    }

    isLowStamina() {
        return this.getStaminaRatio() < 0.25;
    }
}