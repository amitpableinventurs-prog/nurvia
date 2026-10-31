// What a user can switch push on and off for, on the "Turn on notifications" screen and in
// notification settings. A notification's topic is the first part of its type (reminder.due → reminder).
// Types not listed here (account, vendor, seller and staff updates, announcements) are always pushed
// while notifications are on. Switching a topic off stops the push only; the in-app inbox keeps everything.
export const NOTIFICATION_TOPICS = [
  {
    key: 'reminders',
    label: 'Vaccination & care reminders',
    description: 'Vaccines, deworming and medicines when they are due',
    types: ['reminder'],
  },
  {
    key: 'bookings',
    label: 'Appointments',
    description: 'Booking confirmations, changes and visit updates from your vet or groomer',
    types: ['booking', 'visit'],
  },
  {
    key: 'orders',
    label: 'Orders & deliveries',
    description: 'Shop orders, deliveries and returns',
    types: ['shop'],
  },
  {
    key: 'safety',
    label: 'Lost & found alerts',
    description: "When someone scans your pet's tag, and SOS alerts you respond to",
    types: ['nfc', 'sos'],
  },
  {
    key: 'community',
    label: 'Community & adoption',
    description: 'Replies to your posts, community dog updates and adoption applications',
    types: ['community', 'community_dog', 'adoption'],
  },
  {
    key: 'rewards',
    label: 'Rewards',
    description: 'Points earned and referral rewards',
    types: ['loyalty', 'referral'],
  },
];

export const TOPIC_KEYS = NOTIFICATION_TOPICS.map((t) => t.key);

const topicByType = new Map(NOTIFICATION_TOPICS.flatMap((t) => t.types.map((type) => [type, t.key])));

export const topicOf = (type) => topicByType.get(type.split('.')[0]) ?? null;

// "Not now" on the screen: ask again after 3 days, then 7, then every 30.
const ASK_AGAIN_DAYS = [3, 7, 30];
export const askAgainAfterDays = (laterCount) => ASK_AGAIN_DAYS[Math.min(laterCount, ASK_AGAIN_DAYS.length) - 1];
