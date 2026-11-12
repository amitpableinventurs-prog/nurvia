import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signUpByPhone, startDb, stopDb } from './helpers.js';

let asha, meera;
const HOME = { label: 'Home', name: 'Asha Rao', phone: '9845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001', location: { lat: 12.9758, lng: 77.6101 } };

beforeAll(async () => {
  await startDb();
  asha = await signUpByPhone('Asha');
  meera = await signUpByPhone('Meera');
});
afterAll(stopDb);

describe('saved addresses', () => {
  it('needs a signed-in user, and starts empty', async () => {
    await api().get('/users/me/addresses').expect(401);
    await api().post('/users/me/addresses').send(HOME).expect(401);
    expect((await asha.http.get('/users/me/addresses').expect(200)).body).toEqual([]);
  });

  it('adds addresses one at a time and keeps each user apart', async () => {
    const first = await asha.http.post('/users/me/addresses').send(HOME).expect(201);
    expect(first.body[0]).toMatchObject({ label: 'Home', name: 'Asha Rao', phone: '+919845000000', location: { type: 'Point', coordinates: [77.6101, 12.9758] } });
    expect(first.body[0]._id).toBeTruthy();

    const second = await asha.http.post('/users/me/addresses').send({ line1: 'Office', city: 'Indore' }).expect(201);
    expect(second.body.map((a) => a.line1)).toEqual(['12 MG Road', 'Office']);
    expect((await asha.http.get('/users/me/addresses').expect(200)).body).toHaveLength(2);
    expect((await meera.http.get('/users/me/addresses').expect(200)).body).toEqual([]);
  });

  it('refuses bad input, and an eleventh address even when sent in parallel', async () => {
    await meera.http.post('/users/me/addresses').send({ city: 'Indore' }).expect(400);
    await meera.http.post('/users/me/addresses').send({ line1: 'x', city: 'Indore', pincode: '12' }).expect(400);
    await meera.http.post('/users/me/addresses').send({ line1: 'x', city: 'Indore', phone: '123' }).expect(400);

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => meera.http.post('/users/me/addresses').send({ line1: `Flat ${i}`, city: 'Indore' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect((await meera.http.get('/users/me/addresses').expect(200)).body).toHaveLength(10);
  });

  it('still replaces the whole list with PUT, keeping name and phone', async () => {
    const put = await asha.http.put('/users/me/addresses').send({ addresses: [{ line1: 'New home', city: 'Pune', name: 'Asha Rao', phone: '+919845000000' }] }).expect(200);
    expect(put.body).toHaveLength(1);
    expect(put.body[0]).toMatchObject({ line1: 'New home', name: 'Asha Rao', phone: '+919845000000' });
  });
});

describe('help and support', () => {
  it('works signed out and returns what the screen shows', async () => {
    const { body } = await api().get('/config/support').expect(200);
    expect(body.careDesk.title).toBe('Care desk');
    expect(body.contact).toMatchObject({ email: 'support@nurviapetcare.com', hours: 'Monday to Friday, 9:00 AM – 6:00 PM IST' });
    expect(body.questions.map((q) => q.question)).toEqual(['Where is my order?', 'How do I change a visit?', "How do I update my pet's record?", 'Why are shops not near me?']);
    for (const q of body.questions) expect(q.answer).toBeTruthy();
  });
});
