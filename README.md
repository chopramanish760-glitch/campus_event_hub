# Campus Event Hub

A full-stack campus event management platform that helps students discover events, register for activities, join waitlists, volunteer, and receive real-time updates. Organizers and administrators can manage events, bookings, approvals, notifications, and media from a centralized dashboard.

## Features

* Student registration and login
* Event creation and management
* QR-based ticket registration
* Waitlist management
* Volunteer applications and approvals
* Admin dashboard
* Organizer dashboard
* Real-time event updates
* Notifications system
* Media uploads and management
* MongoDB Atlas integration
* Persistent data storage
* REST API backend

## Tech Stack

### Backend

* Node.js
* Express.js
* MongoDB Atlas
* GridFS
* Multer
* CORS
* dotenv

### Frontend

* HTML
* CSS
* JavaScript

### Deployment

* Render
* GitHub

## Project Structure

```text
backend.js
data.json
index.html
uploads/
package.json
.env.example
```

## Installation

### Clone Repository

```bash
git clone https://github.com/chopramanish760-glitch/campus_event_hub.git
cd campus_event_hub
```

### Install Dependencies

```bash
npm install
```

### Configure Environment Variables

Create a `.env` file:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
MONGODB_DB_NAME=campus_event_hub
```

### Start Server

```bash
npm start
```

Server will run at:

```text
http://localhost:5000
```

## API Endpoints

### Events

```http
GET /api/events
POST /api/events
```

### Notifications

```http
GET /api/notifications/:regNumber
```

### Volunteers

```http
POST /api/volunteers/add
POST /api/volunteers/respond
```

### Tickets

```http
POST /api/tickets
```

## Highlights

* Real-time event updates
* QR-based event registration
* Volunteer workflow management
* Waitlist handling
* Admin and organizer controls
* MongoDB-powered storage
* Media upload support

## Author

Manish Chopra
