from setuptools import setup, find_packages

setup(
    name="ds-tt",
    version="0.1.0",
    description="DS-TT: Device-Side TSN Translator for 5G-TSN Integration",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[
        "pyserial>=3.5",
        "pyroute2>=0.7.0",
        "pyyaml>=6.0",
    ],
    entry_points={
        "console_scripts": [
            "ds-tt=ds_tt.__main__:main",
        ],
    },
    package_data={
        "": ["../web/**/*"],
    },
)
