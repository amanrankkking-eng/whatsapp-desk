// The page list. To add a page: write pages/<name>.js exporting { id, title, icon, create() }
// (see docs/EXTENDING.md) and add it here. The order here is the order in the menu.
import overview from './overview.js';
import chats from './chats.js';
import today from './today.js';
import resellers from './resellers.js';
import alerts from './alerts.js';
import attention from './attention.js';
import numbers from './numbers.js';
import messages from './messages.js';
import reports from './reports.js';
import settings from './settings.js';
import log from './log.js';

export const PAGES = [overview, chats, today, resellers, alerts, attention, numbers, messages, reports, settings, log];
