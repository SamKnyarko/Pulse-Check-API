'use strict';


function fireAlert(monitor) {
  const timestamp = new Date().toISOString();

  const payload = {
    ALERT: `Device ${monitor.id} is down!`,
    time: timestamp,
  };

 
  console.log(JSON.stringify(payload));

  
  if (monitor.alertEmail) {
    console.log(
      `[notify] Would email ${monitor.alertEmail}: monitor "${monitor.id}" ` +
      `missed its ${monitor.timeoutSeconds}s heartbeat window.`
    );
  }
}

module.exports = { fireAlert };
