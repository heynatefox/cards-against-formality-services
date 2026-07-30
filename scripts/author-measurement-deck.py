#!/usr/bin/env python3
"""Wave 2 of the Signal deck: heat ladders + paraphrase trios.

Heat ladders: same referent, same joke structure, transgression escalating
1..5, everything else held constant. A player's picks across a ladder turn
their tone ceiling from a point estimate into a curve, per flavor.

Paraphrase trios: same joke, three deliveries (flat / concrete / oblique),
matched on every tag. Win rates by variant separate WHAT people laugh at
from HOW they like it told, which is the transferable half.

Idempotent: merges into signal-cards-v1.json by source_id.
"""
import json, os, sys

PAYLOAD = os.path.expanduser(
    '~/cards-against-formality-services/services/games-service/src/data/signal-cards-v1.json')
ORIGIN = 'authored_2026-07-30'

# ── Heat ladders ──────────────────────────────────────────────────────────
# (flavor, ladder_slug, {mode, register, sincerity}, [rung1..rung5])
# Axes are constant within a ladder BY DESIGN; only heat moves.
LADDERS = [
    # ---- MORBID: death and decay, escalating from cozy to unforgivable ----
    ('morbid', 'grandma', {'m': -3, 'r': -1, 's': 1}, [
        "Grandma's secret cookie recipe.",
        "Grandma's ashes in a Pringles can.",
        "Scattering Grandma in the casino parking lot, per her wishes.",
        "Stretching Grandma's urn with fireplace ash to fool the relatives.",
        "Reporting Grandma missing instead of paying for a funeral.",
    ]),
    ('morbid', 'family-dog', {'m': -3, 'r': -2, 's': 1}, [
        "The family dog's little birthday hat.",
        "Explaining the farm upstate with a straight face.",
        "The vet's itemized bill for putting Buster down.",
        "Getting a refund on the dog's unused obedience classes, same day.",
        "Burying the dog shallow because the ground was hard and you were tired.",
    ]),
    ('morbid', 'funeral', {'m': -3, 'r': -1, 's': 0}, [
        "Crying at a stranger's funeral.",
        "Checking your phone during the eulogy.",
        "Live-tweeting the burial.",
        "A tip jar at the open casket.",
        "Heckling the widow.",
    ]),
    ('morbid', 'obituary', {'m': -3, 'r': 0, 's': 0}, [
        "An obituary with a typo.",
        "An obituary that ends with a link to his SoundCloud.",
        "An obituary written by the ex who won.",
        "An obituary that settles a score with the deceased.",
        "A child's obituary with sponsored content.",
    ]),
    ('morbid', 'hospital', {'m': -3, 'r': -1, 's': 1}, [
        "Hospital Jell-O.",
        "The ICU's most punchable get-well balloon.",
        "Unplugging something in the ICU to charge your phone.",
        "Guessing which machine was Dad's off switch.",
        "The pediatric ward's going-out-of-business sale.",
    ]),
    ('morbid', 'last-words', {'m': -3, 'r': -1, 's': 2}, [
        "Famous last words, misquoted.",
        "Last words that were mostly about brunch.",
        "Last words interrupted by a ringtone.",
        "Last words naming the sibling she actually liked.",
        "Last words, auctioned to the highest-bidding grandchild.",
    ]),

    # ---- SEXUAL: escalating from flirty to florid ----
    ('sexual', 'honeymoon', {'m': -3, 'r': -2, 's': 1}, [
        "The honeymoon suite's complimentary chocolates.",
        "The honeymoon suite's mirrored ceiling.",
        "The honeymoon suite's surprisingly specific room service menu.",
        "The honeymoon suite's cleaning fee, itemized.",
        "The honeymoon suite's hidden camera, and the in-laws' group chat.",
    ]),
    ('sexual', 'romance-novel', {'m': -3, 'r': 0, 's': 0}, [
        "The steamy paperback in Mom's beach bag.",
        "Chapter eleven, the one with the stable boy.",
        "The dog-eared pages of Mom's favorite chapter.",
        "Mom's margin notes in the stable boy chapter.",
        "Finding out Dad is the uncredited author.",
    ]),
    ('sexual', 'browser-history', {'m': -3, 'r': -2, 's': 1}, [
        "A browser history cleared out of politeness.",
        "An incognito tab, closed with reflexes you didn't know you had.",
        "A browser history that requires a family meeting.",
        "A browser history the IT guy now brings up at parties.",
        "A browser history entered into evidence.",
    ]),
    ('sexual', 'massage', {'m': -3, 'r': -1, 's': 1}, [
        "A gift-card massage you keep forgetting to book.",
        "The massage therapist's warming oils.",
        "A massage parlor with a loyalty punch card.",
        "The massage parlor's police sketch of a regular.",
        "The massage parlor's Yelp reviews, read aloud in court.",
    ]),
    ('sexual', 'dating-profile', {'m': -3, 'r': -2, 's': 1}, [
        "A dating profile that's just golden retriever photos.",
        "A dating profile that opens with a shirtless mirror pic.",
        "A dating profile that mentions his mattress twice.",
        "A dating profile listing exactly what he's into, alphabetized.",
        "Grandpa's dating profile, and the word 'insatiable.'",
    ]),
    ('sexual', 'sex-ed', {'m': -3, 'r': -1, 's': 2}, [
        "The sex-ed teacher's laminated diagrams.",
        "The banana from fourth-period sex ed.",
        "The sex-ed teacher losing control of the Q&A.",
        "The sex-ed teacher's personal anecdotes.",
        "Sex ed taught by the priest, from memory.",
    ]),

    # ---- TABOO: sacred things, handled worse and worse ----
    ('taboo', 'church', {'m': -3, 'r': 0, 's': 1}, [
        "The church potluck's mystery casserole.",
        "Checking fantasy scores during the homily.",
        "The collection plate's new tap-to-pay reader.",
        "Charging admission for communion.",
        "The priest's burner phone.",
    ]),
    ('taboo', 'thanksgiving', {'m': -3, 'r': -1, 's': 2}, [
        "Thanksgiving with assigned seating.",
        "Uncle Gary's opinions, uninvited.",
        "Uncle Gary explaining who's really in charge of the banks.",
        "Grace, but it's Uncle Gary's manifesto now.",
        "Thanksgiving ending with somebody's citizenship being questioned.",
    ]),
    ('taboo', 'hr-department', {'m': -3, 'r': 0, 's': 1}, [
        "A strongly worded email to HR.",
        "HR's mandatory fun day.",
        "The HR complaint that names the CEO.",
        "HR's settlement calculator.",
        "HR's shredder, running all night before the audit.",
    ]),
    ('taboo', 'national-anthem', {'m': -3, 'r': 0, 's': 0}, [
        "Forgetting the words to the national anthem.",
        "An air-guitar solo during the national anthem.",
        "Selling ad time inside the national anthem.",
        "The national anthem, but every verse is about oil now.",
        "The national anthem, performed at the war crime.",
    ]),
    ('taboo', 'therapy', {'m': -3, 'r': 0, 's': 2}, [
        "A therapist's waiting-room fish tank.",
        "A therapist who says 'yikes' out loud.",
        "A therapist who charges extra for the childhood stuff.",
        "A therapist selling your breakthroughs to a podcast.",
        "A therapist who testifies for whoever pays first.",
    ]),
    ('taboo', 'billionaire', {'m': -3, 'r': 0, 's': 0}, [
        "A billionaire's skincare routine.",
        "A billionaire's emotional support yacht.",
        "A billionaire buying the town that sued him.",
        "A billionaire's charity that only funds his legal defense.",
        "A billionaire outliving three organ donors he never met.",
    ]),

    # ---- GROSS-OUT: the body, betraying you harder each rung ----
    ('gross_out', 'buffet', {'m': -3, 'r': -3, 's': 1}, [
        "The all-you-can-eat buffet's sneeze guard.",
        "The buffet's shrimp, at hour six.",
        "Going back for thirds while the first two fight it out.",
        "The buffet bathroom's one working stall.",
        "The health inspector's photos, laminated for the trial.",
    ]),
    ('gross_out', 'gym', {'m': -3, 'r': -3, 's': 1}, [
        "The gym's communal yoga mats.",
        "The guy who doesn't wipe down the bench.",
        "The smell the spin studio can't evict.",
        "The hot tub at the gym, and everything it's forgiven.",
        "The lost-and-found bin's unclaimed jockstrap, still warm.",
    ]),
    ('gross_out', 'leftovers', {'m': -3, 'r': -3, 's': 1}, [
        "Leftovers of unknown age.",
        "The Tupperware that's a science project now.",
        "The office fridge's smell, given a name and a memorial.",
        "Scraping off the green part and serving it anyway.",
        "Month-old potato salad at the family reunion, and the ambulance queue.",
    ]),
    ('gross_out', 'porta-potty', {'m': -3, 'r': -4, 's': 1}, [
        "The music festival's porta-potties.",
        "The porta-potty's mystery puddle.",
        "Dropping your phone in the porta-potty and going in after it.",
        "The porta-potty tipping over with a friend inside.",
        "The porta-potty at hour forty-eight, weaponized by the sun.",
    ]),
    ('gross_out', 'swimming-pool', {'m': -3, 'r': -3, 's': 1}, [
        "The public pool's floating Band-Aid.",
        "The warm spot in the public pool.",
        "The pool's chlorine, fighting for its life.",
        "What the pool filter caught on the Fourth of July.",
        "The kiddie pool's brown alert, and the lifeguard who quit on the spot.",
    ]),
    ('gross_out', 'airplane', {'m': -3, 'r': -3, 's': 1}, [
        "The airplane's shared armrest.",
        "Bare feet on the tray table.",
        "The airplane bathroom after the meal service.",
        "The guy in 14C's cough, itemized by droplet.",
        "The barf bag relay in row fourteen.",
    ]),
]

# ── Paraphrase trios ──────────────────────────────────────────────────────
# (set_slug, heat, {mode, register, sincerity}, flat, concrete, oblique)
TRIOS = [
    ('fired', 1, {'m': -4, 'r': -1, 's': 1},
     "Getting fired.",
     "Getting walked out by security holding a cardboard box and a sad little plant.",
     "A lanyard that stops working at 4:59 PM."),
    ('bad-date', 1, {'m': -4, 'r': -1, 's': 1},
     "A terrible first date.",
     "A first date where he brings a coupon and his mom calls twice.",
     "Two waters, one check, zero eye contact."),
    ('hangover', 2, {'m': -4, 'r': -2, 's': 1},
     "A brutal hangover.",
     "Waking up on the bathroom floor holding a traffic cone and someone else's shoes.",
     "The sun, filing assault charges."),
    ('divorce', 2, {'m': -4, 'r': -1, 's': 1},
     "An ugly divorce.",
     "Splitting the record collection while the lawyers bill by the minute.",
     "The wedding album, listed as evidence."),
    ('taxes', 1, {'m': -4, 'r': 0, 's': 1},
     "Doing your taxes.",
     "Shoebox receipts and a calculator at 11 PM on April 14th.",
     "A yearly essay contest where the prize is keeping your own money."),
    ('aging', 1, {'m': -4, 'r': -1, 's': 2},
     "Getting old.",
     "Grunting when you sit down and again when you stand up.",
     "A knee that predicts the weather better than the news."),
    ('group-chat', 1, {'m': -4, 'r': -2, 's': 1},
     "Being left out of the group chat.",
     "Watching three dots appear and vanish in the chat they made without you.",
     "A party you can hear through the wall."),
    ('road-rage', 2, {'m': -4, 'r': -2, 's': 1},
     "Road rage.",
     "Screaming at a Corolla while your kids learn four new words.",
     "A horn played like a threat."),
    ('diet', 1, {'m': -4, 'r': -1, 's': 1},
     "Cheating on a diet.",
     "Eating cake over the sink at midnight like a raccoon in pajamas.",
     "A salad, avenged."),
    ('karaoke', 1, {'m': -4, 'r': -2, 's': 1},
     "Bad karaoke.",
     "Butchering 'Total Eclipse of the Heart' while the bar files out.",
     "A microphone that should have a restraining order."),
    ('landlord', 2, {'m': -4, 'r': -1, 's': 1},
     "A terrible landlord.",
     "A landlord who paints over the mold and calls it renovated.",
     "Rent going up faster than the ceiling comes down."),
    ('wedding', 1, {'m': -4, 'r': -1, 's': 1},
     "An awkward wedding toast.",
     "The best man's toast mentioning two exes and a parole officer.",
     "A champagne flute nobody wants to raise."),
    ('printer', 1, {'m': -4, 'r': -1, 's': 1},
     "The office printer not working.",
     "The printer jamming on page one of forty, ink at 2%, IT on lunch.",
     "A machine that senses deadlines."),
    ('gym-january', 1, {'m': -4, 'r': -1, 's': 1},
     "Quitting the gym in February.",
     "Twelve monthly payments for the three times you actually went.",
     "A resolution with a 21-day warranty."),
    ('therapy-bill', 2, {'m': -4, 'r': 0, 's': 2},
     "Needing therapy because of your family.",
     "Paying $180 an hour to talk about one Thanksgiving from 2009.",
     "An heirloom nobody wanted, passed down anyway."),
]

FLAVOR_SECONDARY = {'morbid': 'edge_comfort.morbid', 'sexual': 'edge_comfort.sexual',
                    'taboo': 'edge_comfort.taboo', 'gross_out': 'edge_comfort.gross_out'}

def build():
    cards = []
    for flavor, slug, axes, rungs in LADDERS:
        assert len(rungs) == 5, f'{slug}: needs 5 rungs'
        for i, text in enumerate(rungs):
            rung = i + 1
            cards.append({
                'source_id': f'lad-{flavor[:3]}-{slug}-r{rung}',
                'cardType': 'white', 'text': text, 'pick': None,
                'signal': {
                    'version': 2, 'origin': ORIGIN, 'heat': rung, 'class': 'probe',
                    'measures': {'primary': 'heat', 'secondary': FLAVOR_SECONDARY[flavor]},
                    'axes': axes, 'flavors': [flavor],
                    'ladder': {'id': f'{flavor[:3]}-{slug}', 'rung': rung, 'flavor': flavor},
                },
            })
    for slug, heat, axes, flat, concrete, oblique in TRIOS:
        for variant, text in (('flat', flat), ('concrete', concrete), ('oblique', oblique)):
            cards.append({
                'source_id': f'par-{slug}-{variant}',
                'cardType': 'white', 'text': text, 'pick': None,
                'signal': {
                    'version': 2, 'origin': ORIGIN, 'heat': heat, 'class': 'probe',
                    'measures': {'primary': 'delivery.style', 'secondary': None},
                    'axes': axes, 'flavors': [],
                    'paraphrase': {'setId': slug, 'variant': variant},
                },
            })
    return cards

def main():
    new = build()
    texts = [c['text'] for c in new]
    assert len(set(texts)) == len(texts), 'duplicate card text'
    assert len(set(c['source_id'] for c in new)) == len(new), 'duplicate source_id'

    payload = json.load(open(PAYLOAD))
    have = {c['source_id'] for c in payload['cards']}
    have_text = {c['text'] for c in payload['cards']}
    added = 0
    for c in new:
        if c['source_id'] in have or c['text'] in have_text:
            continue
        payload['cards'].append(c)
        added += 1
    json.dump(payload, open(PAYLOAD, 'w'), indent=1, ensure_ascii=False)
    print(f'authored {len(new)} cards ({sum(1 for c in new if "ladder" in c["signal"])} ladder rungs, '
          f'{sum(1 for c in new if "paraphrase" in c["signal"])} paraphrase variants); '
          f'added {added} new to payload; payload now {len(payload["cards"])} cards')

if __name__ == '__main__':
    main()
