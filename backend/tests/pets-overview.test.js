import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BREEDS, seedBreeds } from '../scripts/breeds.js';
import { AdoptionListing } from '../src/modules/adoption/adoption.model.js';
import { Breed } from '../src/modules/pets/pet.model.js';
import { createAdmin, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const DAY = 86_400_000;

let admin;
let user;

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  user = await signUpByPhone('Asha');
});
afterAll(stopDb);

describe('My Pets screen', () => {
  it('shows the empty state with the add-pet choices', async () => {
    const { body } = await user.http.get('/pets/overview').expect(200);
    expect(body).toMatchObject({ count: 0, empty: true, pets: [], emptyState: { actions: [{ key: 'add_pet', primary: true }] } });
    expect(body.addPet.species.map((s) => s.key)).toEqual(['dog', 'cat', 'bird', 'small_animal', 'rabbit', 'fish', 'other']);
  });

  it('lists the breeds for the chosen species in display order', async () => {
    await tenantRun(seedBreeds);
    await tenantRun(() => Breed.updateOne({ species: 'dog', slug: 'beagle' }, { active: false }));

    const dogs = await user.http.get('/pets/breeds?species=dog').expect(200);
    expect(dogs.body.items.map((b) => b.name)).toEqual(['Golden Retriever', 'Labrador', 'Indie']);
    const small = await user.http.get('/pets/breeds?species=small_animal').expect(200);
    expect(small.body.items.map((b) => b.name)).toEqual(BREEDS.small_animal);
    await user.http.get('/pets/breeds?species=dragon').expect(400);
    await tenantRun(() => Breed.updateOne({ species: 'dog', slug: 'beagle' }, { active: true }));
  });

  it('offers adoption only while it is switched on and has open listings', async () => {
    await tenantRun(() =>
      AdoptionListing.create({ postedBy: admin.user._id, name: 'Kali', species: 'dog', description: 'Friendly indie', city: 'Bengaluru', status: 'open' }),
    );
    const open = await user.http.get('/pets/overview').expect(200);
    expect(open.body.emptyState.actions).toContainEqual({ key: 'adopt', primary: false, openListings: 1 });

    await admin.http.patch('/admin/platform/features').send({ adoption: false }).expect(200);
    const off = await user.http.get('/pets/overview').expect(200);
    expect(off.body.emptyState.actions.map((a) => a.key)).toEqual(['add_pet']);
    await admin.http.patch('/admin/platform/features').send({ adoption: true }).expect(200);
  });

  it('lists pets with their next due reminder once one is added', async () => {
    const bruno = (await user.http.post('/pets').send({ name: 'Bruno', species: 'dog', breed: 'Indie' }).expect(201)).body;
    await user.http.post('/pets').send({ name: 'Mishti', species: 'cat' }).expect(201);
    await user.http.post(`/pets/${bruno._id}/reminders`).send({ title: 'Deworming', dueAt: new Date(Date.now() + 30 * DAY) }).expect(201);
    await user.http.post(`/pets/${bruno._id}/reminders`).send({ title: 'Rabies booster', dueAt: new Date(Date.now() + 5 * DAY) }).expect(201);

    const { body } = await user.http.get('/pets/overview').expect(200);
    expect(body).toMatchObject({ count: 2, empty: false, emptyState: null });
    expect(body.pets.map((p) => p.name)).toEqual(['Bruno', 'Mishti']);
    expect(body.pets[0]).toMatchObject({ breed: 'Indie', lost: false, nextReminder: { title: 'Rabies booster' } });
    expect(body.pets[1].nextReminder).toBeNull();
  });

  it("never shows another owner's pets", async () => {
    const other = await signUpByPhone('Rahul');
    expect((await other.http.get('/pets/overview').expect(200)).body).toMatchObject({ count: 0, empty: true });
  });
});
