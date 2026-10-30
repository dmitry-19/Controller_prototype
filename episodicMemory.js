// js/episodicMemory.js
export class EpisodicMemory {
    constructor() {
        this.events = [];
        this.maxEvents = 100;
    }

    addEvent(type, data = {}) {
        const event = {
            type,
            ...data,
            timestamp: performance.now(),
            decayRate: type === 'damage' ? 0.005 : 0.1, // негатив затухает очень медленно (полужизнь ~2.5 мин)
            weight: 1.0
        };
        this.events.push(event);
        if (this.events.length > this.maxEvents) {
            this.events.shift();
        }
        console.log(`[EpisodicMemory] event: ${type}, zone: ${data.zone}, force: ${data.force?.toFixed(1)}`);
    }

    update(deltaSec) {
        const now = performance.now();
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            const age = (now - ev.timestamp) / 1000;
            ev.weight = Math.exp(-ev.decayRate * age);
            if (ev.weight < 0.05) {
                this.events.splice(i, 1);
            }
        }
    }

    getFearBonus(subtype = null) {
        let bonus = 0;
        for (const ev of this.events) {
            if (ev.type !== 'damage') continue;
            if (subtype && ev.subtype !== subtype) continue;
            bonus += ev.force * 0.1 * ev.weight;
        }
        return Math.min(1.0, bonus);
    }

    getRecentDamage(zone = null) {
        let total = 0;
        for (const ev of this.events) {
            if (ev.type !== 'damage') continue;
            if (zone && ev.zone !== zone) continue;
            total += ev.force * ev.weight;
        }
        return total;
    }
}