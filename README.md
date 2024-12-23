# File to XML Paster

A desktop application that allows you to drag and drop files to generate XML format for ChatGPT conversations.

## Features

- Drag and drop file support
- Automatic XML conversion
- Copy to clipboard functionality
- Windows support

## Prerequisites

- Node.js (Latest LTS version recommended)
- npm (Comes with Node.js)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Ottocr/XML-o1-Pro-Coder.git
cd XML-o1-Pro-Coder
```

2. Install dependencies:
```bash
npm install
```

## Development

To run the application in development mode:
```bash
npm start
```

## Building

### Build for Windows
```bash
npm run build
```
This will create a Windows installer in the `dist` directory.

### Create unpacked build
```bash
npm run pack
```
This creates an unpacked build in the `dist` directory.

### Create distribution
```bash
npm run dist
```
This creates distributable packages for the current platform.

## Project Structure

- `main.js` - Main Electron process
- `renderer.js` - Renderer process
- `index.html` - Main application window
- `styles.css` - Application styling

## License

ISC

## Author

OttoCR
