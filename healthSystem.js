// js/healthSystem.js
export class HealthSystem {
    constructor(staminaSystem, options = {}) {
        this.stamina = staminaSystem;
        this.maxHealth = options.maxHealth ?? 100;
        this.currentHealth = options.currentHealth ?? this.maxHealth;
        this.healthRegenRate = options.healthRegenRate ?? 2;
        this.healthRegenStaminaThreshold = 0.8;
        this.damageResistanceByZone = {
            head: 1.5,
            torso: 1.0,
            arm: 0.8,
            leg: 0.7,
            pelvis: 1.2,
            other: 0.9
        };
    }

    takeDamage(rawDamage, zone = 'other') {
        const multiplier = this.damageResistanceByZone[zone] || 1.0;
        const damage = rawDamage * multiplier;
        const staminaBefore = this.stamina.currentStamina;
        const staminaDamage = Math.min(staminaBefore, damage);
        this.stamina.consume(staminaDamage);
        const remaining = damage - staminaDamage;
        const healthDamage = Math.min(this.currentHealth, remaining);
        this.currentHealth = Math.max(0, this.currentHealth - healthDamage);
        console.log(`[Health] zone: ${zone}, raw: ${rawDamage.toFixed(1)}, mult: ${multiplier.toFixed(1)}, stamina dmg: ${staminaDamage.toFixed(1)}, health dmg: ${healthDamage.toFixed(1)}`);
        return { staminaDamage, healthDamage };
    }

    update(deltaSec, isInSanctuary = false) {
        const staminaRatio = this.stamina.getNormalized();
        if (staminaRatio >= this.healthRegenStaminaThreshold && this.currentHealth < this.maxHealth) {
            const rate = this.healthRegenRate * (isInSanctuary ? 3.0 : 1.0);
            this.currentHealth = Math.min(this.maxHealth, this.currentHealth + rate * deltaSec);
        }
    }

    getMaxStamina() {
        const healthRatio = Math.max(0.1, this.currentHealth / this.maxHealth);
        return this.stamina.maxStamina * healthRatio;
    }

    getHealthNormalized() {
        return this.currentHealth / this.maxHealth;
    }

    isDead() {
        return this.currentHealth <= 0;
    }
}