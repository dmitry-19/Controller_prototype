// js/trustModel.js
export class TrustModel {
    constructor(initialTrust = 0.6) {
        this.trust = initialTrust;
        this._recoveryRate = 0.08; // ускорено
        this._decayRate = 0.1;
        this._damageImpact = 0.005; // уменьшено вдвое
        this._minTrust = 0.0;
        this._maxTrust = 1.0;
    }

    update(deltaSec, isSafe, playerPushingTowardDanger) {
        if (!playerPushingTowardDanger) {
            this.trust = Math.min(this._maxTrust, this.trust + this._recoveryRate * 0.5 * deltaSec);
        }
        if (isSafe) {
            this.trust = Math.min(this._maxTrust, this.trust + this._recoveryRate * 1.5 * deltaSec);
        }
        if (playerPushingTowardDanger) {
            this.trust = Math.max(this._minTrust, this.trust - this._decayRate * 2.0 * deltaSec);
        }
    }

    recordDamage(force) {
        if (force > 2.0) { // порог из физики
            this.trust = Math.max(this._minTrust, this.trust - force * this._damageImpact);
            console.log(`[Trust] dropped to ${this.trust.toFixed(2)} after damage (force: ${force.toFixed(1)})`);
        }
    }

    getTrust() {
        return this.trust;
    }
}