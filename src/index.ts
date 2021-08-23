import * as env from 'dotenv';
env.config();
import { Gpio } from 'onoff';
import {exec} from 'child_process';
import { readFileSync, writeFile, existsSync } from 'fs';
import { machineIdSync } from 'node-machine-id';
import firebase from 'firebase'


export enum State {
    OFFLINE, // Disconnected to online service
    ONLINE, // Connected to online service
    AVAILABLE, // There is no car charging
    UNAVAILABLE, // There is a car charging
    STOP, // Emergency stopping unit
    ERROR, // Something went wrong
}

export interface IConfig {
    linkedID: string;
    uid?: string;
    name: string;
    message: string;
    state: State;
    currentPower: number;
    currentTimeStart: number;
    powerMode: {
        type: 'DC' | 'AC';
        power: number;
        price: number;
        billing: 'time' | 'session';
    }[];
    localisation: {
        lat: number;
        lng: number;
    };
    createdAt: number;
    updatedAt: number;
}



const powerPort = new Map<number, Gpio>();
let detectorPort: Gpio | undefined;
process.on('SIGINT', (_) => {
    powerPort.forEach((v) => { v.unexport() });
});

const timerStep = (ref: firebase.firestore.DocumentReference, config: IConfig) => {
    setTimeout(() => {
        const time = firebase.firestore.Timestamp.now().toMillis();
        config.updatedAt = time;
        ref.set(
            {
                updatedAt: time,
            },
            { merge: true },
        );
        timerStep(ref, config);
    }, 60000);
};

export const main = async (): Promise<void> => {
    try {
        console.log('Initialization Hardware')
        const POWER_PORT = process.env.POWER_PORT;
        const DETECTOR_PORT = process.env.DETECTOR_PORT;
        if (!POWER_PORT || !DETECTOR_PORT) {
            throw new Error('Missing environment variable');
        }
        try {
            const portPower = JSON.parse(POWER_PORT) as { port: number, power: number }[];

            const check:number[] = [];
            portPower.forEach((v) => {
                if (!check.includes(v.port)) {
                    const tgpio = new Gpio(v.port, 'out');
                    powerPort.set(v.power, tgpio);
                    tgpio.writeSync(0);
                    check.push(v.port);
                }
            })

            const port = Number.parseInt(DETECTOR_PORT);
            detectorPort = new Gpio(port, 'in', 'rising', {debounceTimeout: 10})
        } catch (error) {
            throw new Error(error)
        }
        

        console.log('Initialization Software');
        const UID = machineIdSync();
        
        const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;
        const CONFIG_FILE = process.env.CONFIG_FILE;

        if (!FIREBASE_CONFIG || !CONFIG_FILE) {
            throw new Error('Missing environment variable');
        }

        if (!existsSync(CONFIG_FILE)) {
            throw new Error("Invalid config path");
            
        }

        let CONFIG: IConfig | undefined;
        try {
            const configUnformat = readFileSync(CONFIG_FILE, 'utf-8');
            CONFIG = JSON.parse(configUnformat) as IConfig;
        } catch (error) {
            throw new Error("Unreadable config file");
        }

        firebase.initializeApp(JSON.parse(FIREBASE_CONFIG));
        var db = firebase.firestore();

        let rechargeDeviceSnap = await db.collection('rechargeDevices').doc(CONFIG.linkedID).get();
        if (!rechargeDeviceSnap.exists) {
            const rechargeDevicesSnap = await db.collection('rechargeDevices').where('uid', '==', UID).get();
            if (!rechargeDevicesSnap.empty) {
                rechargeDeviceSnap = rechargeDevicesSnap.docs[0];
            } else {
                throw new Error('Device not registered into database');
            }
            
        }

        CONFIG = { ...rechargeDeviceSnap.data() as IConfig, linkedID: rechargeDeviceSnap.id };

        if (!CONFIG.uid) {
            rechargeDeviceSnap.ref.set({ uid: UID } as Partial<IConfig>, { merge: true });
            CONFIG.uid = UID;
        }

        const onNext = (snapshot: firebase.firestore.DocumentSnapshot<firebase.firestore.DocumentData>): void => {
            const snapData = { ...snapshot.data() as IConfig, linkedID: rechargeDeviceSnap.id };
            if (JSON.stringify(snapData) !== JSON.stringify(CONFIG)) {
                //Update offline config
                CONFIG = snapData;
                writeFile(CONFIG_FILE, JSON.stringify({...CONFIG, currentMode: -1, currentTimeStart: 0, state: State.OFFLINE} as IConfig), (err) => {
                    throw new Error(err?.message);
                });
            }

            if (snapData.state == State.STOP) {
                exec('shutdown now', function (error, stdout, stderr) {
                    console.error(stdout);
                });
            } else if (
                snapData.state == State.UNAVAILABLE &&
                snapData.currentPower > 0 &&
                snapData.currentTimeStart != 0
            ) {
                const gpio = powerPort.get(snapData.currentPower);
                if (gpio) {
                    gpio.write(0);
                } else {
                    snapshot.ref.set(
                        {
                            state: State.ERROR,
                            message: 'Power unavalable',
                            updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                            currentPower: 0,
                            currentTimeStart: 0,
                        },
                        { merge: true },
                    );
                }
            }
            else {
                console.log('Action unrequired');
            }
        }
        //Doccument update loop
        db.collection('rechargeDevices').doc(CONFIG.linkedID).onSnapshot({ next: onNext });
        timerStep(rechargeDeviceSnap.ref, CONFIG); //Update status loop (To check if device is online)
        //Vehicule connection loop
        detectorPort.watch((err, value) => {
            if (err) {
                throw err;
            }
            
            if (value) {
                if (CONFIG && firebase.firestore.Timestamp.now().toMillis() - CONFIG.updatedAt < 80) {
                        rechargeDeviceSnap.ref.set(
                            {
                                state: State.UNAVAILABLE,
                                message: 'Connected',
                                updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                                currentPower: 0,
                                currentTimeStart: firebase.firestore.Timestamp.now().toMillis(),
                            },
                            { merge: true },
                        );
                    }
                    
                } else {
                powerPort.forEach((v) => v.write(1));
                if (CONFIG && firebase.firestore.Timestamp.now().toMillis() - CONFIG.updatedAt < 80) {
                    rechargeDeviceSnap.ref.set(
                        {
                            state: State.AVAILABLE,
                            message: 'Disconnected',
                            updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                            currentPower: 0,
                            currentTimeStart: 0,
                        },
                        { merge: true },
                    );
                }
                    
                }
        })
    } catch (error) {
        console.error(error);
    }
    

}
main();
