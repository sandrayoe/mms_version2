# mms_version2
Low-level version of MMS website interface (fewer features, less disruptions.)

This is just for sensor readings, record, and then download the .csv file.

1. Sensor readings are parsed from binary bits into 2 sensor values. 
    Regarding signals:
    a. Faster updates: 100ms 
    b. Smoother: smoothed every bin of 20ms
    c. Window width: 200 samples
    d. Assumed sample rate 50 Hz (interval 20ms)
2. Recording: start (marked by dotted green line); stop (dotted red line)
3. Recorded csv: time,sensor1,sensor2




{##CANCELED## - but kept for notes}
Needs: 
1. Check the commands from the superelectrodes (fix? electrode 1?)
2. Download from both flex sensors (with the labels; csv)

Manual-stimulation // MP search
sensor[nmbr] || sensorVal || variation from sensorVal(%) || timeStamps || amplitude || anode-cathode || stimulationActive || ...
... || parameters: freq, phase dur, etc. 


3. Peak detector of the signal (min-max-avg)?
4. Impedance? Voltage? 
5. Parameters controllable
6. Electrodes 1-2 problem
7. Problem with the signal sensor (NULL values?)


Maybe? 
1. Battery indicator? 
