# Cards Against Formality - Services

Cards Against Formality aims to be a web based clone of the popular card game "Cards against humanity".

# Getting started

**Once the project has developed more. Feel free to start contributing!**

Cards Against Formality Services are built using an event-driven microservice architecture.

Most of the Services are small Node applications written in Typescript. Each microservice should strictly conform to the single DB per service pattern, along with solely performing atomic operations. Furthermore, abide by the strict microservice methodology.

The Node services are built using the [moleculerjs](https://moleculer.services/) framework.
With the NATS message queue acting as the backbone of the application.

All development and deployment is handled within a containerised environment. Containerisation is managed by [Docker](https://www.docker.com/), and container orchestration by [Kubernetes](https://kubernetes.io/).

## Dependencies

The project only has 4 dependencies for local development:
 - A package manager, **yarn** or **npm**
 - **Skaffold** to handle the CI/CD pipeline
 - **Docker** for containerisation
 - **kubectl** the kubernetes command line tool

## Installation

Once you've insured you have installed all the above dependencies, follow these steps to start contributing.

Clone the repository

  git clone https://github.com/JordanPawlett/cards-against-formality-services.git

Run the dev server!

  yarn run dev

Expose the remote debug port - All dev node servers will have a debugger exposed on port 9229.

  kubectl port-forward [name-of-service]-service 9229:9229

Skaffold will handle hot-code changes, ensuring pods will be swapped out of the running kubernetes cluster.