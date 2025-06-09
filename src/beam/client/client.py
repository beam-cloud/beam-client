from typing import Any, Callable, Union

import requests
from beta9.client import client
from beta9.client.deployment import Deployment
from beta9.client.task import Task
from beta9.exceptions import DeploymentNotFoundError
from requests.exceptions import HTTPError

from . import settings


class Client(client.Client):
    def __init__(self, token: str) -> None:
        self._deployment_cache = {}

        super().__init__(
            token=token,
            gateway_host=settings.api_host,
            gateway_port=settings.api_port,
            tls=settings.api_port == 443,
        )

        self.internal_api_host = settings.internal_api_host
        self.internal_api_port = settings.internal_api_port

        if self.tls:
            self.internal_api_host = f"https://{self.internal_api_host}"
        else:
            self.internal_api_host = f"http://{self.internal_api_host}:{self.internal_api_port}"

    def get_deployment(self, identifier: str) -> Deployment:
        """Get a handle to a deployment by its identifier, for example:

        ```python
        deployment = client.get_deployment("beam-cloud/function/transcribe/v1")
        task = deployment.submit(input={"url": "https://example.com/audio.mp3"})
        print(task.result(wait=True))
        ```

        Args:
            identifier (str): The identifier of the deployment.

        Returns:
            Deployment: The deployment object.
        """
        if identifier in self._deployment_cache:
            return self._deployment_cache[identifier]

        try:
            response = requests.get(
                url=f"{self.internal_api_host}/v2/deployment/get-public-deployment-url/?slug={identifier}",
                headers={"Authorization": f"Bearer {self.token}"},
            )
            response.raise_for_status()
        except HTTPError:
            raise DeploymentNotFoundError(f"Deployment not found: {identifier}")

        deployment = Deployment(
            token=self.token,
            base_url=self.base_url,
            workspace_id=self.workspace_id,
            deployment_url=response.json()["url"],
        )
        self._deployment_cache[identifier] = deployment
        return deployment

    def submit(self, identifier: str, *, input: dict = {}) -> Union[Task, Any]:
        """Submit a task to a deployment.

        This is a convenience method that combines get_deployment and submit.

        Args:
            identifier (str): The identifier of the deployment
            input (dict, optional): The input data for the task. Defaults to {}.

        Returns:
            Union[Task, Any]: A Task object if the task runs asynchronously,
                            otherwise the JSON response from the deployment.
        """
        deployment = self.get_deployment(identifier)
        return deployment.submit(input=input)

    def subscribe(
        self, identifier: str, *, input: dict = {}, event_handler: Callable = None
    ) -> Any:
        """Submit a task to a deployment and subscribe to the task (blocks until the task is complete).

        This is a convenience method that combines get_deployment and subscribe.

        Args:
            identifier (str): The identifier of the deployment
            input (dict, optional): The input data for the task. Defaults to {}.

        Returns:
            Any: The JSON response from the deployment, or None.
        """
        deployment = self.get_deployment(identifier)
        return deployment.subscribe(input=input)

    def download_file(self, url: str, local_path: str) -> bytes:
        """Download a file from a URL."""

        response = requests.get(url)
        response.raise_for_status()

        with open(local_path, "wb") as f:
            f.write(response.content)

    def __del__(self) -> None:
        self._deployment_cache.clear()
