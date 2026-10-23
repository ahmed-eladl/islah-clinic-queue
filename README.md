# 🏥 Live Clinic Queue Tracker (100% Free & Simple)

A lightweight, zero-complexity web application designed to eliminate crowded waiting rooms in outpatient clinics and hospitals.

- **Nurses/Doctors**: Have an ultra-simple touch controller with big `+1 Next` and `-1 Recall` buttons.
- **Patients**: Scan a QR code on their phone, see the live queue number update in real time without refreshing, and hear an audible chime when their turn is close.

---

## ⚡ How to Run It in 1 Step

Open your terminal in this folder and run:

```bash
npm start
```

That's it! The server will start at **`http://localhost:3000`**.

---

## 🔑 Clinic Logins (Ready to Use)

Open **`http://localhost:3000/staff.html`** to log in as clinic staff:

| Clinic Station | Room | Username | Password |
| :--- | :--- | :--- | :--- |
| **Pediatrics Clinic** | Room 101 | `pediatrics` | `pediatrics123` |
| **Cardiology Clinic** | Room 204 | `cardiology` | `cardiology123` |
| **General Practice** | Room 102 | `general` | `general123` |
| **Dental Clinic** | Room 305 | `dental` | `dental123` |

*Inside the nurse controller, you will see a big QR code ready to print or show to patients, plus large one-touch buttons.*

---

## 📱 How Patients Use It

Patients do **not** need to install any app or log in. They simply open:
- **`http://localhost:3000/?clinic=pediatrics`** (or scan the QR code from the nurse's screen).

They can:
1. Watch the **"Now Serving"** number change in real time.
2. Enter their ticket number (e.g. `14`) to see **"X patients ahead of you (~15 mins)"**.
3. Hear a bell chime when their number is called.

---

## 🌐 How to Get a Free Public Link for Patients' Phones

### Method 1: Instant Free Link using Cloudflare Tunnel (Zero Cost, No Account Needed)
1. Download [cloudflared](https://github.com/cloudflare/cloudflared/releases) (or install via `winget install --id Cloudflare.cloudflared`).
2. Run this command:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Cloudflare gives you an instant free HTTPS link (e.g., `https://random-name.trycloudflare.com`).  
   Patients anywhere can open this link on their phones!

### Method 2: Free 24/7 Cloud Hosting (Render.com)
1. Create a free account on [Render.com](https://render.com).
2. Connect your GitHub repository.
3. Choose **Web Service**, set Build Command: `npm install`, Start Command: `npm start`.
4. Render will give you a permanent free link (e.g., `https://my-hospital-queue.onrender.com`).
