// src/ProfileGreetings.js — dynamic, time-aware profile greetings. Every call can return a different line.
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

const MORNING = [
  'Good morning, {n} ☀️ make today count.', 'Rise and shine, {n}!', 'Morning, {n} — fresh day, fresh snaps.',
  'Good morning, {n}. Coffee first, then conquer.', 'Hey {n}, the world woke up — go say hi.',
  'Early bird, {n}? Your feed is warm.', 'Morning, {n}! Somebody probably liked your last post.',
  'A new day, {n}. What will you share?', 'Good morning, {n} — your people are waiting.',
  'Top of the morning, {n} ✨', 'Sun is up, {n}. So is Snapsa.', 'Good morning {n}, go make someone smile today.',
  'Hello {n}! Fresh start, fresh vibes.', 'Morning, {n}. Big things start small — post something.',
  'Wakey wakey, {n} 😄 the feed missed you.',
];
const AFTERNOON = [
  'Good afternoon, {n} 🌤️', 'Hey {n}, how is your day going?', 'Afternoon, {n} — time for a quick scroll?',
  'Good afternoon {n}, any good snaps today?', 'Midday check-in, {n}: you are doing great.',
  'Afternoon, {n}! Take a break, see what is new.', 'Hey {n}, halfway through the day — drink some water 💧',
  'Good afternoon, {n}. Your friends posted while you were busy.', 'Lunch break, {n}? Perfect time to catch up.',
  'Hello {n}! The feed is lively right now.', 'Afternoon vibes, {n} ✌️', 'Good to see you, {n}. What is on your mind?',
  'Hey {n}, share a moment from your day.', 'Keep going, {n} — the day is still yours.', 'Good afternoon, {n}. Go be awesome.',
];
const EVENING = [
  'Good evening, {n} 🌆', 'Evening, {n}! How was your day?', 'Hey {n}, time to unwind — see what is trending.',
  'Good evening {n}, the best snaps come out at night.', 'Welcome back, {n}. Let us see what you missed.',
  'Evening, {n} — kick back and scroll.', 'Good evening, {n}. Share the highlight of your day.',
  'Hello {n}! Golden hour, golden posts ✨', 'Hey {n}, long day? You made it. 🙌', 'Evening vibes, {n} 🎶',
  'Good evening {n}, your world is right here.', 'Dinner done, {n}? Catch up with your circle.',
  'Good evening, {n}. Someone is probably thinking of you.', 'Time to relax, {n}. Snapsa has you.',
  'Evening, {n}! Tell your story from today.',
];
const NIGHT = [
  'Good night, {n} 🌙', 'Late one, {n}? The night owls are out.', 'Hey {n}, do not stay up too late 😴',
  'Still up, {n}? The night feed is a different world.', 'Night mode on, {n} 🌌', 'Sleepy yet, {n}? One last scroll maybe.',
  'Good night {n} — sweet dreams after this snap.', 'Quiet hours, {n}. Perfect for a good watch.',
  'Midnight crew, {n} 🦉 welcome.', 'Rest up soon, {n}. Tomorrow needs you.', 'The stars are out, {n} ✨',
  'Hey {n}, the late-night posts hit different.',
];
const DAYS = {
  0: ['Sunday reset, {n} 🧘 recharge.', 'Happy Sunday, {n}! Slow down and enjoy.', 'Lazy Sunday, {n}? Snapsa is perfect for it.'],
  1: ['Happy Monday, {n} 💪 let us go.', 'New week, {n}. New wins.', 'Monday, {n}! Start strong.'],
  2: ['Tuesday energy, {n}. Keep the momentum.', 'Hey {n}, happy Tuesday ⚡', 'Tuesday already, {n}. You have got this.'],
  3: ['Midweek, {n}. Keep pushing.', 'Happy Wednesday, {n}! Halfway there.', 'Hump day, {n} 🐫 almost there.'],
  4: ['Thursday, {n} — Friday is almost here.', 'Happy Thursday, {n}! One more push.', 'Almost the weekend, {n} 😉'],
  5: ['It is Friday, {n}! 🎉', 'Happy Friday, {n} — weekend mode loading.', 'Friday vibes, {n}. Celebrate something.'],
  6: ['Happy Saturday, {n}! 🥳', 'Weekend, {n}! Go make memories.', 'Saturday, {n} — share the fun.'],
};
const ANY = [
  'Welcome back, {n}.', 'Good to see you, {n} 👋', 'Hey {n}, your world, all in one place.', 'What are you up to, {n}?',
  'Ready to see what is trending, {n}?', 'Hope you are having a good one, {n}.', 'Let us see what is new, {n}.',
  'Hello {n}, you look great today 😎', 'Hey {n}! Make something worth watching.', 'Your people missed you, {n}.',
  'Hi {n}. Post, connect, repeat.', 'Snapsa loves having you, {n} 💜', 'Anything exciting today, {n}?',
  'Go on {n}, drop a snap.', '{n}, the community is better with you in it.',
];

export function makeGreeting(firstName, now = new Date(), salt = 0) {
  const n = (firstName || 'there').trim() || 'there';
  const h = now.getHours();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const seed = dayOfYear * 31 + h * 7 + salt * 13 + Math.floor(Math.random() * 1000);
  const timeSet = h < 5 ? NIGHT : h < 12 ? MORNING : h < 18 ? AFTERNOON : h < 22 ? EVENING : NIGHT;
  // mix: 50% time of day, 25% weekday, 25% general
  const r = Math.abs(seed) % 4;
  const pool = r < 2 ? timeSet : r === 2 ? DAYS[now.getDay()] : ANY;
  return pick(pool, seed >> 2).replace(/\{n\}/g, n);
}
