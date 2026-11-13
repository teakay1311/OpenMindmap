'use strict';

const parent = Number(process.env.OPENMINDMAP_LAUNCHER_PID);
const stopIfOrphaned = () => {
  if (!parent || process.ppid !== parent) process.exit(0);
};
stopIfOrphaned();
setInterval(stopIfOrphaned, 1000).unref();
require('./server.js');
