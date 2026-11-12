import { env } from '../../config/env.js';

// The app's Help & Support screen. It lives here rather than in the app, so the text can change
// without an app release.
const QUESTIONS = [
  {
    id: 'order-status',
    question: 'Where is my order?',
    answer: 'Open your orders to see where each one is: placed, confirmed, shipped or delivered. We also send you a notification when the status changes.',
  },
  {
    id: 'change-visit',
    question: 'How do I change a visit?',
    answer: 'Open the booking and reschedule it. You can do this yourself up to 2 hours before the visit. After that you can still cancel it, or email the care desk for help.',
  },
  {
    id: 'update-pet-record',
    question: "How do I update my pet's record?",
    answer: "Open your pet's profile to edit their details, add health records and set reminders.",
  },
  {
    id: 'shops-near-me',
    question: 'Why are shops not near me?',
    answer: 'We show shops within 5 km of your location. Check that your location is right, or search a wider area. Nurvia may also not be live in your city yet.',
  },
];

export const supportContent = () => ({
  careDesk: { title: 'Care desk', description: 'Weekdays, 9am to 6pm IST. We reply on the same email thread.' },
  contact: {
    email: env.support.email,
    hours: 'Monday to Friday, 9:00 AM – 6:00 PM IST',
  },
  questions: QUESTIONS,
});
