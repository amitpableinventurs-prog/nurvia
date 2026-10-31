// Demo data for trying the apps: staff, pet parents, vendors (live and awaiting KYC review), pets and health records,
// bookings, reviews, community posts and reports, community dogs, adoption listings, the shop catalogue and about two
// months of history so the dashboards have shape. Used by `npm run dev:memory` and `npm run seed:demo`.
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { encrypt } from '../src/common/crypto.js';
import { env } from '../src/config/env.js';
import { CommissionConfig } from '../src/modules/finance/finance.model.js';
import { NfcTag } from '../src/modules/nfc/nfc.model.js';
import { VendorCustomer, VendorStaff } from '../src/modules/operations/operations.model.js';
import { Plan } from '../src/modules/plans/plan.model.js';
import { SosResponder } from '../src/modules/sos/sos.model.js';
import { runWithTenant } from '../src/common/tenancy.js';
import { ROLES } from '../src/common/roles.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { Tenant } from '../src/modules/tenants/tenant.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Vendor, Service, SearchLog } from '../src/modules/vendors/vendor.model.js';
import { Pet, HealthRecord, Reminder } from '../src/modules/pets/pet.model.js';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Post } from '../src/modules/community/community.model.js';
import { QUARANTINE_REASON, Report } from '../src/modules/reports/report.model.js';
import { audit } from '../src/modules/audit/audit.model.js';
import { AdoptionApplication, AdoptionListing } from '../src/modules/adoption/adoption.model.js';
import { seedCatalog } from './demo-catalog.js';
import { City } from '../src/modules/platform/platform.model.js';
import { seedBreeds } from './breeds.js';
import { CITIES, VENDOR_CATEGORIES } from './launch-config.js';
import { CommunityDog, CareLog } from '../src/modules/community-dogs/community-dog.model.js';

export const DEMO_ADMIN = { email: 'admin@nurvia.local', password: 'nurvia-dev-password' };

export async function seedDemoData() {
  await Tenant.create({ slug: env.defaultTenant, name: 'Nurvia Petcare' });
  const HOURS = [1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '19:00' }));
  const day = (offset, hour) => new Date(Date.now() + offset * 86_400_000).setUTCHours(hour - 5, 30, 0, 0);

  await runWithTenant(env.defaultTenant, async () => {
    const superAdmin = await User.create({ email: DEMO_ADMIN.email, name: 'Dev Admin', roles: [ROLES.SUPER_ADMIN], passwordHash: await hashPassword(DEMO_ADMIN.password) });

    const vendorCategories = await Category.create(VENDOR_CATEGORIES.map(([name, slug], sortOrder) => ({ kind: 'vendor', name, slug, sortOrder })));
    const bySlug = (slug) => vendorCategories.find((c) => c.slug === slug);
    const [vet, groom, shop] = ['vet-clinic', 'grooming', 'pet-shop'].map(bySlug);

    // The launch rollout, except that Bengaluru is switched on here: all the demo vendors are there.
    // A real database seeded with `npm run seed` starts with Bengaluru as coming soon.
    await City.create(CITIES.map((c) => (c.slug === 'bengaluru' ? { ...c, status: 'active' } : c)));
    await Category.create([
      { kind: 'service', name: 'Consultation', slug: 'consultation' },
      { kind: 'service', name: 'Bath & groom', slug: 'bath-groom' },
    ]);
    await seedBreeds();

    const people = await User.create(
      ['Asha Rao', 'Vikram Shah', 'Meera Iyer', 'Dr. Kiran Patel', 'Sana Groomers', 'Rohit Pets'].map((name, i) => ({
        name,
        phone: `+9198450000${String(i).padStart(2, '0')}`,
        // Meera (index 2) also owns Wag & Wash Grooming, so she is a vendor too.
        roles: i >= 2 ? [ROLES.PET_PARENT, ROLES.VENDOR] : [ROLES.PET_PARENT],
        createdAt: new Date(Date.now() - (20 - i * 3) * 86_400_000),
      })),
    );
    const [asha, vikram, meera, kiran, sana, rohit] = people;

    const bengaluru = (dLat, dLng) => ({ type: 'Point', coordinates: [77.5946 + dLng, 12.9716 + dLat] });
    const clinic = await Vendor.create({
      owner: kiran._id, businessName: 'Happy Paws Veterinary Clinic', categories: [vet._id],
      address: { line1: '14 100 Feet Road, Indiranagar', city: 'Bengaluru', pincode: '560038' }, location: bengaluru(0.01, 0.05),
      operatingHours: HOURS, status: 'active',
      kyc: { status: 'approved', gstin: '29ABCDE1234F1Z5', submittedAt: new Date(Date.now() - 10 * 86_400_000), reviewedAt: new Date() },
      ratingAvg: 4.5, ratingCount: 2,
      timeOff: [{ from: new Date(day(4, 9)), to: new Date(day(4, 14)), reason: 'Dr. Kiran at a CME workshop' }],
    });
    await Vendor.create({
      owner: sana._id, businessName: 'Sana Pet Grooming Studio', categories: [groom._id],
      address: { line1: '22 5th Block, Koramangala', city: 'Bengaluru', pincode: '560095' }, location: bengaluru(-0.03, 0.03),
      operatingHours: HOURS, status: 'pending', kyc: { status: 'submitted', pan: 'ABCDE1234F', submittedAt: new Date() },
    });
    // Two more applications waiting on KYC review: one past its 24-hour SLA with a checked licence,
    // one whose licence still needs a manual check. (The document file ids are placeholders.)
    const [arvind, pawprint] = await User.create(
      ['Dr. Arvind Menon', 'Pawprint Hydrotherapy'].map((name, i) => ({ name, phone: `+9198450001${i}0`, roles: [ROLES.PET_PARENT, ROLES.VENDOR] })),
    );
    const placeholderFile = () => new mongoose.Types.ObjectId();
    const arvindClinic = await Vendor.create({
      owner: arvind._id, businessName: "Dr. Arvind's Companion Clinic", categories: [vet._id],
      address: { line1: '9 CMH Road', line2: 'Indiranagar Stage II', city: 'Bengaluru', pincode: '560038' }, location: bengaluru(0.008, 0.04),
      operatingHours: HOURS, status: 'pending',
      kyc: {
        status: 'submitted', gstin: '29AAFCA1234B1Z2', submittedAt: new Date(Date.now() - 30 * 3_600_000),
        documents: [{ type: 'shop_license', file: placeholderFile(), name: 'bbmp-trade-licence.pdf' }, { type: 'vet_license', file: placeholderFile(), name: 'kvc-registration.pdf' }],
        licenseCheck: { status: 'verified', note: 'Matched on the BBMP trade licence register', by: superAdmin._id, at: new Date(Date.now() - 2 * 3_600_000) },
      },
    });
    await Vendor.create({
      owner: pawprint._id, businessName: 'Pawprint Holistic Hydrotherapy', categories: [groom._id],
      address: { line1: '41 80 Feet Road', line2: 'Koramangala 4th Block', city: 'Bengaluru', pincode: '560034' }, location: bengaluru(-0.035, 0.025),
      operatingHours: HOURS, status: 'pending',
      kyc: { status: 'submitted', submittedAt: new Date(Date.now() - 20 * 3_600_000), documents: [{ type: 'shop_license', file: placeholderFile(), name: 'trade-licence-scan.jpg' }] },
    });
    const petStore = await Vendor.create({
      owner: rohit._id, businessName: 'Rohit Pet Supplies', categories: [shop._id], status: 'active',
      kyc: { status: 'approved', gstin: '29AAACR5055K1Z5', submittedAt: new Date(), reviewedAt: new Date() },
      address: { line1: '3 Jayanagar 4th Block', city: 'Bengaluru' }, location: bengaluru(-0.04, -0.01), operatingHours: HOURS,
      phone: '+919845000005', store: { type: 'pet_store', locality: 'Jayanagar', tags: ['Curated treats & food', 'Prescription diet shelf'], inStorePickup: true },
    });
    const [consult] = await Service.create([
      { vendor: clinic._id, name: 'General consultation', pricePaise: 60000, durationMin: 30, description: 'Full check-up, weight and vitals, diet advice.' },
      { vendor: clinic._id, name: 'Vaccination visit', pricePaise: 45000, durationMin: 30, description: 'Core vaccines with certificate. Vaccine cost extra.' },
      { vendor: clinic._id, name: 'Dental scaling', pricePaise: 250000, durationMin: 90 },
    ]);
    const wagWash = await Vendor.create({
      owner: meera._id, businessName: 'Wag & Wash Grooming', categories: [groom._id], homeVisits: true,
      description: 'Gentle, cage-free grooming with natural shampoos. Anxious pups welcome.',
      address: { line1: '8 Defence Colony, Indiranagar', city: 'Bengaluru', pincode: '560038' }, location: bengaluru(0.02, 0.06),
      operatingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '10:00', close: '20:00' })), status: 'active',
      kyc: { status: 'approved', submittedAt: new Date(), reviewedAt: new Date() }, ratingAvg: 5, ratingCount: 1,
      store: { type: 'boutique', locality: 'Indiranagar', tags: ['Natural shampoos', 'Grooming tools'], inStorePickup: true },
    });
    await Service.create([
      { vendor: wagWash._id, name: 'Bath & blow-dry', pricePaise: 89900, durationMin: 60 },
      { vendor: wagWash._id, name: 'Full groom with haircut', pricePaise: 149900, durationMin: 90 },
      { vendor: wagWash._id, name: 'Nail trim', pricePaise: 29900, durationMin: 30 },
    ]);

    const pets = await Pet.create([
      { owner: asha._id, name: 'Bruno', species: 'dog', breed: 'Indie', sex: 'male', dateOfBirth: new Date('2023-03-14'), weightKg: 18.5, neutered: true, microchipId: '981020000123456', allergies: ['chicken'] },
      { owner: asha._id, name: 'Pista', species: 'cat', breed: 'Indian shorthair', sex: 'female', dateOfBirth: new Date('2024-08-01'), weightKg: 3.4 },
      { owner: vikram._id, name: 'Misty', species: 'cat', breed: 'Persian' },
      { owner: meera._id, name: 'Coco', species: 'dog', breed: 'Beagle' },
    ]);

    const now = Date.now();
    const daysAgo = (n) => new Date(now - n * 86_400_000);
    const inDays = (n) => new Date(now + n * 86_400_000);
    await HealthRecord.create([
      { pet: pets[0]._id, owner: asha._id, type: 'vaccination', title: 'Rabies', date: daysAgo(350), nextDueDate: inDays(15), vet: { clinic: 'Happy Paws Veterinary Clinic' } },
      { pet: pets[0]._id, owner: asha._id, type: 'vaccination', title: 'DHPPi', date: daysAgo(340), vet: { clinic: 'Happy Paws Veterinary Clinic' } },
      { pet: pets[0]._id, owner: asha._id, type: 'deworming', title: 'Drontal Plus', date: daysAgo(60), nextDueDate: inDays(30) },
      { pet: pets[0]._id, owner: asha._id, type: 'vet_visit', title: 'Itchy paws', date: daysAgo(21), notes: 'Mild allergy. Switched to fish-based food; recheck in 4 weeks.', vet: { name: 'Dr. Kiran Patel', clinic: 'Happy Paws Veterinary Clinic' } },
      { pet: pets[0]._id, owner: asha._id, type: 'weight', title: '18.5 kg', date: daysAgo(21) },
      { pet: pets[1]._id, owner: asha._id, type: 'vaccination', title: 'Tricat', date: daysAgo(40) },
    ]);
    await Reminder.create([
      { pet: pets[0]._id, owner: asha._id, title: 'Bruno: Rabies booster due', dueAt: inDays(15) },
      { pet: pets[0]._id, owner: asha._id, title: 'Recheck itchy paws', dueAt: inDays(2) },
      { pet: pets[1]._id, owner: asha._id, title: 'Pista: flea treatment', dueAt: inDays(5), repeat: 'monthly' },
    ]);

    const snapshot = { name: consult.name, pricePaise: consult.pricePaise, durationMin: 30, mode: 'at_store' };
    const bookings = [
      [asha, pets[0], 1, 10, 'pending', 'unpaid'],
      [vikram, pets[2], 2, 11, 'accepted', 'paid'],
      [meera, pets[3], -3, 15, 'completed', 'paid'],
      [asha, pets[0], -9, 16, 'completed', 'paid'],
      [asha, pets[0], -6, 12, 'cancelled', 'refunded'],
    ];
    await Booking.create(
      bookings.map(([user, pet, offset, hour, status, paymentStatus], i) => ({
        code: `NVDEMO${i + 1}`, user: user._id, pet: pet._id, vendor: clinic._id, vendorOwner: kiran._id, service: consult._id,
        serviceSnapshot: snapshot, scheduledAt: day(offset, hour), endsAt: day(offset, hour) + 30 * 60_000, status,
        statusHistory: [{ status: 'pending', action: 'create', by: user._id }, ...(status !== 'pending' ? [{ status, action: status, by: kiran._id }] : [])],
        payment: {
          status: paymentStatus,
          gateway: paymentStatus === 'unpaid' ? undefined : 'mock',
          amountPaise: snapshot.pricePaise,
          paidAt: paymentStatus === 'unpaid' ? undefined : new Date(Date.now() + (offset - 2) * 86_400_000),
        },
        createdAt: new Date(Date.now() + (offset - 2) * 86_400_000),
      })),
    );

    // Today's schedule at the clinic: one visit under way and one later in the day.
    await Booking.create(
      [
        ['NVTODAY1', vikram, pets[2], -10, 'accepted', 'paid'],
        ['NVTODAY2', asha, pets[0], 180, 'pending', 'unpaid'],
      ].map(([code, user, pet, startOffsetMin, status, paymentStatus]) => {
        const scheduledAt = new Date(now + startOffsetMin * 60_000);
        return {
          code, user: user._id, pet: pet._id, vendor: clinic._id, vendorOwner: kiran._id, service: consult._id, serviceSnapshot: snapshot,
          scheduledAt, endsAt: new Date(scheduledAt.getTime() + 30 * 60_000), status,
          statusHistory: [{ status: 'pending', action: 'create', by: user._id }],
          payment: { status: paymentStatus, amountPaise: snapshot.pricePaise, ...(paymentStatus === 'paid' && { gateway: 'mock', paidAt: daysAgo(1) }) },
          createdAt: daysAgo(1),
        };
      }),
    );

    // About two months of history so the admin dashboard's trends and comparisons have shape.
    // A small seeded generator keeps the demo identical on every start.
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (list) => list[Math.floor(rand() * list.length)];

    const extraParents = await User.create(
      Array.from({ length: 34 }, (_, i) => ({
        name: pick(['Ananya', 'Rahul', 'Priya', 'Arjun', 'Kavya', 'Rohan', 'Isha', 'Karthik', 'Neha', 'Siddharth']) + ' ' + pick(['K', 'S', 'M', 'R', 'P']),
        phone: `+9198451${String(10000 + i).padStart(5, '0')}`,
        createdAt: daysAgo(Math.floor(rand() * rand() * 58) + 0.3),
      })),
    );
    const extraPets = await Pet.create(
      extraParents.map((u, i) => ({ owner: u._id, name: pick(['Leo', 'Milo', 'Bella', 'Simba', 'Coco', 'Tiger', 'Luna', 'Sheru']), species: i % 4 ? 'dog' : 'cat', createdAt: new Date(u.createdAt.getTime() + 3_600_000) })),
    );
    const allServices = await Service.find({ vendor: { $in: [clinic._id, wagWash._id] } }).lean();
    const owners = new Map([[String(clinic._id), kiran._id], [String(wagWash._id), meera._id]]);
    let n = 0;
    await Booking.create(
      extraPets.flatMap((pet, i) => {
        const visits = rand() < 0.45 ? 2 : 1;
        return Array.from({ length: visits }, () => {
          const service = pick(allServices);
          // Weighted toward recent weeks so growth shows when comparing periods.
          const back = Math.max(1, Math.floor(Math.pow(rand(), 1.6) * 58));
          const at = new Date(now - back * 86_400_000);
          at.setUTCHours(4 + Math.floor(rand() * 9), rand() < 0.5 ? 0 : 30, 0, 0);
          const status = rand() < 0.82 ? 'completed' : pick(['cancelled', 'no_show']);
          const paid = status !== 'no_show' && rand() < 0.7;
          n += 1;
          return {
            code: `NVHIST${String(n).padStart(3, '0')}`, user: extraParents[i]._id, pet: pet._id, vendor: service.vendor, vendorOwner: owners.get(String(service.vendor)),
            service: service._id, serviceSnapshot: { name: service.name, pricePaise: service.pricePaise, durationMin: service.durationMin, mode: service.mode },
            scheduledAt: at, endsAt: new Date(at.getTime() + service.durationMin * 60_000), status,
            statusHistory: [{ status: 'pending', action: 'create', by: extraParents[i]._id }, { status, action: status }],
            payment: paid
              ? { status: status === 'cancelled' ? 'refunded' : 'paid', gateway: 'mock', amountPaise: service.pricePaise, paidAt: new Date(at.getTime() - 86_400_000) }
              : { status: 'unpaid' },
            reviewed: true,
            createdAt: new Date(at.getTime() - 2 * 86_400_000),
          };
        });
      }),
    );
    const terms = ['vet', 'groomer', 'boarding', 'vaccination', 'dog walker', 'cat grooming', 'indiranagar vet', 'nail trim', ''];
    await SearchLog.create(
      Array.from({ length: 220 }, () => ({ q: pick(terms) || undefined, hasLocation: true, resultCount: 1 + Math.floor(rand() * 3), createdAt: daysAgo(Math.pow(rand(), 1.4) * 58) })),
    );

    await seedCatalog({ sellers: [petStore._id, wagWash._id] });

    const [, spam] = await Post.create([
      { author: asha._id, text: 'Bruno had his first grooming session today! Wag & Wash were so patient with him.', tags: ['grooming', 'indie'], reactionCount: 4, createdAt: daysAgo(1) },
      { author: vikram._id, text: 'Cheap puppies for sale, DM now!!!', tags: ['sale'], createdAt: daysAgo(2) },
      { author: meera._id, text: 'Brownie got her second vaccine shot today. Thank you to everyone on 12th Main who chipped in for the vet visit.', tags: ['communitydogs', 'indiranagar'], reactionCount: 12, createdAt: daysAgo(0.2) },
      { author: kiran._id, text: "Monsoon tip: dry between your dog's toes after walks. Damp fur between the pads causes most of the itchy-paw visits we see this season.", tags: ['health', 'monsoon'], reactionCount: 27, createdAt: daysAgo(3) },
    ]);
    await Report.create([
      { targetType: 'post', targetId: spam._id, reporter: meera._id, reason: 'spam', severity: 'low', details: 'Selling puppies' },
      { targetType: 'post', targetId: spam._id, reporter: asha._id, reason: 'fraud', severity: 'medium', details: 'Looks like an unlicensed breeder' },
    ]);
    // A dangerous tip flagged by a verified vet: hidden from the feed until a moderator decides.
    const [paracetamol] = await Post.create([
      {
        author: vikram._id, text: 'My 8-month puppy has a fever. Give him a quarter of a Crocin (paracetamol) tablet, works for my kids too!',
        tags: ['health'], status: 'hidden', moderation: { at: daysAgo(0.01), reason: QUARANTINE_REASON }, createdAt: daysAgo(0.05),
      },
    ]);
    await Report.create({
      targetType: 'post', targetId: paracetamol._id, reporter: kiran._id, reason: 'harmful_advice', severity: 'high', quarantined: true,
      details: 'Severe toxicity danger: paracetamol (acetaminophen) causes acute liver damage in dogs. Please remove.', createdAt: daysAgo(0.01),
    });

    const [brownie] = await CommunityDog.create([
      { name: 'Brownie', sex: 'female', approxAgeMonths: 30, area: 'Indiranagar 12th Main', city: 'Bengaluru', location: bengaluru(0.012, 0.028), createdBy: meera._id, caregivers: [meera._id, asha._id], sterilized: true, vaccinationStatus: 'partial', description: 'Shy at first, loves biscuits. Usually naps outside the bakery.', lastLogAt: daysAgo(0.1) },
      { name: 'Kalu', sex: 'male', area: 'CMH Road metro exit', city: 'Bengaluru', location: bengaluru(0.004, 0.035), createdBy: vikram._id, caregivers: [vikram._id], description: 'Big black boy with a white chest patch. Needs sterilisation.', verification: { status: 'verified', at: daysAgo(5) } },
    ]);
    await CareLog.create([
      { dog: brownie._id, by: meera._id, type: 'vaccinated', note: 'Anti-rabies + second DHPPi shot', at: daysAgo(0.2) },
      { dog: brownie._id, by: asha._id, type: 'fed', at: daysAgo(0.1) },
      { dog: brownie._id, by: meera._id, type: 'sterilized', note: 'Recovered well', at: daysAgo(90) },
    ]);
    const momo = await AdoptionListing.create({
      postedBy: kiran._id, name: 'Momo', species: 'cat', sex: 'male', ageMonths: 4, city: 'Bengaluru', status: 'open', vaccinated: true,
      description: 'Rescued from a storm drain at 3 weeks old. Playful, litter-trained and great with other cats. Looking for an indoor home.',
      applicationCount: 1,
    });
    // The lister approved this adopter; the home check is done and staff sign-off is what remains.
    await AdoptionApplication.create({
      listing: momo._id, lister: kiran._id, applicant: vikram._id, status: 'approved', statusNote: 'Lovely family, approved',
      message: 'We are a family of three in an apartment with a netted balcony. We had a cat for 12 years.',
      home: { type: 'apartment', hasOtherPets: false, hasChildren: true, experience: '12 years with a rescue cat' },
      compliance: {
        status: 'pending',
        homeCheck: { status: 'passed', note: 'Visited by a CARE volunteer. Balcony netting in place.', at: daysAgo(1) },
        microchip: { scheduledAt: inDays(4) },
      },
    });
    await AdoptionListing.create({
      postedBy: meera._id, name: 'Kali', species: 'dog', sex: 'female', ageMonths: 24, city: 'Bengaluru',
      description: 'Friendly two-year-old indie, vaccinated and sterilised. Great with children.',
    });
    await audit({ user: superAdmin, ip: '127.0.0.1' }, 'vendor.license_verified', { type: 'vendor', id: arvindClinic._id }, { reason: 'Matched on the BBMP trade licence register' });

    // ---- Phase 2 operations ----
    // Both demo shops are approved marketplace sellers (bank details are placeholders).
    for (const [store, legalName] of [[petStore, 'Rohit Pet Supplies LLP'], [wagWash, 'Wag & Wash Grooming']]) {
      await Vendor.updateOne(
        { _id: store._id },
        {
          seller: {
            status: 'approved', legalName, gstin: '29AAACR5055K1Z5', bank: { accountName: legalName, accountNumberLast4: '9012', ifsc: 'HDFC0001234' },
            pickupAddress: { line1: store.address.line1, city: 'Bengaluru', pincode: '560011' }, submittedAt: daysAgo(30), reviewedAt: daysAgo(29), reviewedBy: superAdmin._id,
          },
          sellerBankAccountEnc: encrypt('123456789012'),
        },
      );
    }
    await CommissionConfig.create({ bookingPct: 10, marketplacePct: 12, updatedBy: superAdmin._id });
    await Plan.create([
      { code: 'vendor-starter', name: 'Starter', audience: 'vendor', pricePaise: 0, features: ['Nurvia listing and bookings', 'CRM for up to 200 customers'], limits: { staff: 2, customers: 200 }, sortOrder: 1 },
      { code: 'vendor-pro', name: 'Pro', audience: 'vendor', pricePaise: 149900, trialDays: 14, features: ['Unlimited customers', 'Staff calendar for 10', 'Packages and reports'], limits: { staff: 10 }, sortOrder: 2 },
      { code: 'store-white-label', name: 'White-label store', audience: 'tenant', pricePaise: 499900, features: ['Branded storefront', 'Own catalogue and orders', 'Optional Nurvia listing'], sortOrder: 1 },
    ]).catch((err) => (err.code === 11000 ? null : Promise.reject(err))); // plans are platform-wide and may already exist

    // Happy Paws has one team member per staff role (sign in with 9845000020-26) and a walk-in customer from outside Nurvia.
    const team = [
      ['Rita (reception)', 'Rita', 'receptionist', '#2563eb'],
      ['Farhan (manager)', 'Farhan', 'manager', '#7c3aed'],
      ['Dr. Nisha (vet)', 'Dr. Nisha', 'vet', '#059669'],
      ['Pooja (groomer)', 'Pooja', 'groomer', '#db2777'],
      ['Arun (trainer)', 'Arun', 'trainer', '#d97706'],
      ['Manoj (walker)', 'Manoj', 'walker', '#0891b2'],
      ['Lakshmi (boarding)', 'Lakshmi', 'boarding_attendant', '#65a30d'],
    ];
    const staffUsers = await User.create(team.map(([name], i) => ({ name, phone: `+9198450000${20 + i}`, roles: [ROLES.PET_PARENT, ROLES.VENDOR_STAFF] })));
    await VendorStaff.create(team.map(([, name, role, color], i) => ({ vendor: clinic._id, user: staffUsers[i]._id, name, phone: staffUsers[i].phone, role, color })));
    await VendorCustomer.create({ vendor: clinic._id, name: 'Neha Kapoor', phone: '+919900011122', source: 'walk_in', pets: [{ name: 'Simba', species: 'cat', breed: 'Persian' }], tags: ['senior-pet'] });
    await VendorCustomer.create({ vendor: clinic._id, user: asha._id, name: asha.name, phone: asha.phone, source: 'nurvia', pets: pets.filter((p) => String(p.owner) === String(asha._id)).map((p) => ({ name: p.name, species: p.species, breed: p.breed, pet: p._id })) });

    // NFC tags: Bruno wears one; five more are waiting to be handed out.
    const tagCode = () => crypto.randomBytes(12).toString('base64url');
    const tagSerial = () => 'NV-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    await NfcTag.create({ code: 'demo-bruno-tag', serial: 'NV-DEMO00001', status: 'active', pet: pets[0]._id, owner: asha._id, activatedAt: daysAgo(10), batch: 'demo' });
    await NfcTag.insertMany(Array.from({ length: 5 }, () => ({ code: tagCode(), serial: tagSerial(), batch: 'demo' })));

    // An animal-welfare volunteer covering Indiranagar receives SOS alerts (the SOS switch starts off).
    await SosResponder.create({ user: meera._id, kind: 'ngo', organisation: 'Indiranagar Animal Care', location: bengaluru(0.01, 0.04), radiusKm: 5 });
  });
}
